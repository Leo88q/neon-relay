#ifndef NEONRELAY_GAME_PAIRING_HTTP_H
#define NEONRELAY_GAME_PAIRING_HTTP_H
#include "game_connection.h"
#include <memory>
#include <vector>
class IHttp;
class IHttpRequest;
namespace neonrelay {
// Start/Poll/destruction on the game thread only. No HTTP-thread callbacks.
class GamePairingHttp
{
public:
	GamePairingHttp(IHttp &Http, std::string Origin, std::string Domain);
	~GamePairingHttp();
	GamePairingHttp(const GamePairingHttp &) = delete;
	GamePairingHttp &operator=(const GamePairingHttp &) = delete;
	bool Start(const std::shared_ptr<GameConnectionIdentity> &Connection, const std::string &Token, const MatchSigner &Signer, int64_t Now);
	void Poll(int64_t Now);
	size_t PendingCount() const { return m_Pending.size(); }
private:
	struct Pending
	{
		std::weak_ptr<GameConnectionIdentity> Connection;
		GameConnectionIdentity::Request Request;
		std::shared_ptr<IHttpRequest> Http;
		int64_t StartedAt;
	};
	IHttp &m_Http;
	std::string m_Origin;
	std::string m_Domain;
	std::vector<Pending> m_Pending;
};
} // namespace neonrelay
#endif // NEONRELAY_GAME_PAIRING_HTTP_H
