// Test-only executable using the REAL engine HTTP worker and pairing adapter.
#include "game_pairing_http.h"
#include "game_pairing_seal.h"
#include <engine/http.h>
#include <engine/shared/config.h>
#include <base/logger.h>
#include <base/secure.h>
#include <cassert>
#include <chrono>
#include <iostream>
#include <mutex>
#include <thread>

CConfig g_Config;
class TestLogger : public ILogger
{
	std::mutex m_Mutex;
public:
	void Log(const CLogMessage *pMessage) override
	{
		std::lock_guard<std::mutex> Guard(m_Mutex);
		std::cout << pMessage->Message() << '\n';
	}
};
static int64_t Now()
{
	return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();
}
// Confidential test IPC substitutes only for the not-yet-implemented client channel.
static int RealBackend(const std::string &Origin, bool ExpectAccepted, bool Sealed, const std::string &Action)
{
	log_set_global_logger(new TestLogger);
	g_Config.m_DbgHttp = 1;
	g_Config.m_HttpAllowInsecure = 1;
	std::unique_ptr<IEngineHttp> Http(CreateEngineHttp());
	assert(Http->Init(std::chrono::milliseconds(0)));
	neonrelay::MatchSigner Signer;
	assert(Signer.LoadSeedHex(std::string(64, '1'))); // isolated test key only
	std::array<unsigned char, 32> Entropy;
	secure_random_fill(Entropy.data(), Entropy.size());
	auto Connection = std::make_shared<neonrelay::GameConnectionIdentity>(Entropy);
	neonrelay::GamePairingHttp Pairing(*Http, Origin, "test.neonrelay.example");
	std::cout << "NONCE " << Connection->Nonce() << std::endl;
	std::string Token;
	if(Sealed)
	{
		const auto Offer = Connection->BeginSealedPairing(Signer, "test.neonrelay.example", Now());
		assert(Offer);
		assert(!Connection->BeginSealedPairing(Signer, "test.neonrelay.example", Now())); // cooldown preserves current offer
		std::cout << "OFFER " << Offer->Json << std::endl;
		std::cout << "OFFER_SIGNATURE " << Offer->Signature << std::endl;
		std::string Envelope;
		assert(std::getline(std::cin, Envelope));
		if(Action != "sealed")
		{
			int64_t CheckTime = Now();
			if(Action == "sealed-disconnect") Connection->Disconnect();
			else if(Action == "sealed-replaced")
			{
				CheckTime += 2000; // synthetic forward clock, no rollback ambiguity
				assert(Connection->BeginSealedPairing(Signer, "test.neonrelay.example", CheckTime));
			}
			else if(Action == "sealed-exhausted")
			{
				for(int i = 0; i < 8; ++i) assert(Connection->OpenSealedPairing("{}", CheckTime).empty());
			}
			else assert(false);
			assert(Connection->OpenSealedPairing(Envelope, CheckTime).empty());
			assert(!Connection->PlayerId(CheckTime));
			Http->Shutdown();
			std::cout << "SEAL_REJECTED" << std::endl;
			return 0;
		}
		auto WrongTag = Envelope;
		const auto TagOffset = WrongTag.find("\"tag\":\"") + 7;
		WrongTag[TagOffset] = WrongTag[TagOffset] == '0' ? '1' : '0';
		assert(Connection->OpenSealedPairing(WrongTag, Now()).empty());
		auto WrongSender = Envelope;
		const auto SenderOffset = WrongSender.find("\"sender_key\":\"") + 14;
		WrongSender.replace(SenderOffset, 64, std::string(64, '0'));
		assert(Connection->OpenSealedPairing(WrongSender, Now()).empty());
		assert(Connection->OpenSealedPairing(std::string(769, 'x'), Now()).empty());
		neonrelay::GamePairingSeal Other;
		assert(Other.Begin(Signer, "test.neonrelay.example", std::string(64, 'f'), Now()));
		assert(Other.OpenEnvelope(Envelope, Now()).empty());
		Token = Connection->OpenSealedPairing(Envelope, Now());
		assert(Token.size() == 43);
		assert(Connection->OpenSealedPairing(Envelope, Now()).empty());
	}
	else assert(std::getline(std::cin, Token));
	assert(Pairing.Start(Connection, Token, Signer, Now()));
	auto Drain = [&]() {
		const auto Deadline = std::chrono::steady_clock::now() + std::chrono::seconds(12);
		while(Pairing.PendingCount())
		{
			assert(std::chrono::steady_clock::now() < Deadline);
			Pairing.Poll(Now());
			std::this_thread::sleep_for(std::chrono::milliseconds(10));
		}
	};
	Drain();
	if(!ExpectAccepted)
	{
		assert(!Connection->PlayerId(Now()));
		Http->Shutdown();
		std::cout << "REJECTED" << std::endl;
		return 0;
	}
	assert(Connection->PlayerId(Now()).value() == "registered-account");
	std::cout << "PAIRED registered-account" << std::endl;
	std::string Nonce, Issued, Expires, Challenge;
	for(auto *Field : {&Nonce, &Issued, &Expires, &Challenge}) assert(std::getline(std::cin, *Field));
	const auto Signature = Connection->SignChallenge(Signer, Nonce, std::stoll(Issued), std::stoll(Expires), Challenge, Now());
	assert(!Signature.empty());
	std::cout << "SIGNATURE " << Signature << std::endl;
	// Retry the actual consumed token: failed refresh must clear old authentication.
	assert(Pairing.Start(Connection, Token, Signer, Now()));
	Drain();
	assert(!Connection->PlayerId(Now()));
	Connection->Disconnect();
	Http->Shutdown();
	std::cout << "REPLAY_REJECTED" << std::endl;
	return 0;
}
int main(int argc, char **argv)
{
	if(argc == 4 && std::string(argv[1]) == "--backend")
		return RealBackend(argv[2], std::string(argv[3]) != "reject", std::string(argv[3]).find("sealed") == 0, argv[3]);
	assert(argc == 5);
	log_set_global_logger(new TestLogger);
	g_Config.m_DbgHttp = 1;
	g_Config.m_HttpAllowInsecure = 1; // sensitive policy MUST override this
	std::unique_ptr<IEngineHttp> Http(CreateEngineHttp());
	assert(Http->Init(std::chrono::milliseconds(0)));
	const std::string Good = argv[1], Plain = argv[2], Untrusted = argv[3], WrongHost = argv[4];
	auto Submit = [&](const std::string &Url, bool Sensitive, long Timeout = 2000) {
		std::shared_ptr<IHttpRequest> R = HttpPostJson(Url.c_str(), "{\"test\":true}");
		if(Sensitive) R->Sensitive();
		R->HeaderString("X-Test-Marker", Sensitive ? "PRIVATE-PAIRING-MARKER-DO-NOT-LOG" : "PUBLIC-CONTROL-MARKER");
		R->MaxResponseSize(4096);
		R->Timeout(CTimeout{1000, Timeout, 0, 0});
		Http->Run(R);
		const auto Deadline = std::chrono::steady_clock::now() + std::chrono::seconds(8);
		while(!R->Done()) { assert(std::chrono::steady_clock::now() < Deadline); std::this_thread::sleep_for(std::chrono::milliseconds(10)); }
		return R;
	};
	assert(Submit(Good + "/ok", true)->State() == EHttpState::DONE);
	for(const auto &Url : {Good + "/redirect", Good + "/downgrade"})
	{
		auto R = Submit(Url, true);
		assert(R->State() == EHttpState::DONE && R->StatusCode() == 307);
	}
	for(const auto &Url : {Untrusted + "/ok", WrongHost + "/ok", Plain + "/forbidden", Good + "/large"})
		assert(Submit(Url, true)->State() == EHttpState::ERROR);
	assert(Submit(Good + "/slow", true, 150)->State() == EHttpState::ERROR);
	// Positive control proves requests and debug capture are not simply disabled.
	assert(Submit(Plain + "/control", false)->State() == EHttpState::DONE);

	neonrelay::MatchSigner Signer;
	assert(Signer.LoadSeedHex(std::string(64, '1'))); // public, synthetic test seed
	std::array<unsigned char, 32> Entropy{}; Entropy.fill(7);
	auto Connection = std::make_shared<neonrelay::GameConnectionIdentity>(Entropy);
	neonrelay::GamePairingHttp Pairing(*Http, Good, "game.example");
	assert(Pairing.Start(Connection, std::string(42, 'A') + "E", Signer, Now()));
	const auto Deadline = std::chrono::steady_clock::now() + std::chrono::seconds(5);
	while(!Connection->PlayerId(Now()))
	{
		assert(std::chrono::steady_clock::now() < Deadline);
		Pairing.Poll(Now());
		std::this_thread::sleep_for(std::chrono::milliseconds(10));
	}
	assert(Connection->PlayerId(Now()).value() == "registered-test-account");
	assert(Pairing.Start(Connection, std::string(42, 'A') + "E", Signer, Now()));
	// Supersession leaves the nonce unchanged. Poll must drop the old HTTP job
	// immediately, whether the worker already finished or is still queued.
	const auto Replacement = Connection->Begin("game.example", Now()).value();
	Pairing.Poll(Now());
	assert(Pairing.PendingCount() == 0);
	assert(Connection->IsPending(Replacement, Now())); // old Fail cannot cancel new attempt
	assert(Pairing.Start(Connection, std::string(42, 'A') + "E", Signer, Now()));
	assert(Connection->BeginSealedPairing(Signer, "game.example", Now()));
	Pairing.Poll(Now());
	assert(Pairing.PendingCount() == 0);
	assert(!Connection->PlayerId(Now()));
	assert(Pairing.Start(Connection, std::string(42, 'A') + "E", Signer, Now()));
	Connection->Disconnect();
	Pairing.Poll(Now());
	assert(Pairing.PendingCount() == 0);
	assert(!Connection->PlayerId(Now()));
	Http->Shutdown();
	std::cout << "PASS: actual HTTP worker TLS/redirect/size/timeout/privacy and pairing Poll lifecycle\n";
}
