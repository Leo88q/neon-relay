#include "game_pairing_http.h"
#include "game_pairing_protocol.h"
#include <engine/http.h>

namespace neonrelay {
GamePairingHttp::GamePairingHttp(IHttp &Http, std::string Origin, std::string Domain) :
	m_Http(Http), m_Origin(std::move(Origin)), m_Domain(std::move(Domain)) {}
GamePairingHttp::~GamePairingHttp()
{
	for(auto &Pending : m_Pending)
	{
		Pending.Http->Abort();
		if(auto Connection = Pending.Connection.lock()) Connection->Fail(Pending.Request);
	}
}
bool GamePairingHttp::Start(const std::shared_ptr<GameConnectionIdentity> &Connection,
	const std::string &Token, const MatchSigner &Signer, int64_t Now)
{
	if(!Connection || !IsPairingOrigin(m_Origin) || m_Pending.size() >= 128) return false;
	const auto Body = PairingRequestJson(Signer, m_Domain, Connection->Nonce(), Token);
	if(Body.empty()) return false;
	const auto Request = Connection->Begin(m_Domain, Now);
	if(!Request) return false;
	for(auto It = m_Pending.begin(); It != m_Pending.end();)
	{
		if(It->Connection.lock() == Connection)
		{
			It->Http->Abort();
			It = m_Pending.erase(It);
		}
		else ++It;
	}
	std::shared_ptr<IHttpRequest> Http = HttpPostJson((m_Origin + "/v2/game/redeem").c_str(), Body.c_str());
	Http->Sensitive();
	Http->MaxResponseSize(4096);
	Http->Timeout(CTimeout{3000, 10000, 128, 5});
	m_Pending.push_back({Connection, *Request, Http, Now});
	m_Http.Run(Http);
	return true;
}
void GamePairingHttp::Poll(int64_t Now)
{
	for(auto It = m_Pending.begin(); It != m_Pending.end();)
	{
		auto Connection = It->Connection.lock();
		const bool TimedOut = Now < It->StartedAt || Now - It->StartedAt >= 10000;
		const bool Current = Connection && Connection->IsPending(It->Request, Now);
		if(Current && !TimedOut && !It->Http->Done()) { ++It; continue; }
		bool Accepted = false;
		if(Current && !TimedOut && It->Http->State() == EHttpState::DONE && It->Http->StatusCode() == 200)
		{
			unsigned char *pData = nullptr;
			size_t Length = 0;
			It->Http->Result(&pData, &Length);
			AuthenticatedGameIdentity Identity;
			std::string Nonce;
			if(pData && Length <= 4096 && ParsePairingResponse(std::string(reinterpret_cast<char *>(pData), Length), Identity, Nonce, Now))
				Accepted = Connection->Complete(It->Request, Nonce, Identity, Now);
		}
		if(!Accepted)
		{
			It->Http->Abort();
			if(Connection) Connection->Fail(It->Request);
		}
		It = m_Pending.erase(It);
	}
}
} // namespace neonrelay
