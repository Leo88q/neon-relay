// Test-only executable using the REAL engine HTTP worker and pairing adapter.
#include "game_pairing_http.h"
#include <engine/http.h>
#include <engine/shared/config.h>
#include <base/logger.h>
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
int main(int argc, char **argv)
{
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
	Connection->Disconnect();
	Pairing.Poll(Now());
	assert(!Connection->PlayerId(Now()));
	Http->Shutdown();
	std::cout << "PASS: actual HTTP worker TLS/redirect/size/timeout/privacy and pairing Poll lifecycle\n";
}
