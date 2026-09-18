#ifndef NEONRELAY_GAME_CONNECTION_H
#define NEONRELAY_GAME_CONNECTION_H

#include "game_identity.h"

#include <array>
#include <limits>
#include <optional>

namespace neonrelay {

// Game-thread-only lifecycle. HTTP completions must be marshalled onto that
// thread and use a weak_ptr to the ORIGINAL instance, never look up a slot id.
// Does not authenticate HTTP: Complete requires a validated trusted HTTPS reply.
class GameConnectionIdentity
{
public:
	struct Request
	{
		std::string Nonce;
		uint64_t Serial;
	};
	explicit GameConnectionIdentity(const std::array<unsigned char, 32> &Random)
	{
		for(unsigned char Byte : Random)
		{
			m_Nonce += "0123456789abcdef"[Byte >> 4];
			m_Nonce += "0123456789abcdef"[Byte & 15];
		}
	}
	GameConnectionIdentity(const GameConnectionIdentity &) = delete;
	GameConnectionIdentity &operator=(const GameConnectionIdentity &) = delete;
	const std::string &Nonce() const { return m_Nonce; }
	void Disconnect()
	{
		m_Connected = false;
		m_Pending = false;
		m_Identity.reset();
		m_Domain.clear();
		m_Nonce.clear();
	}
	std::optional<Request> Begin(const std::string &Domain, int64_t Now)
	{
		if(!Clock(Now) || Domain.empty() || Domain.size() > 253 || m_Serial == std::numeric_limits<uint64_t>::max())
			return std::nullopt;
		m_Identity.reset();
		m_Domain = Domain;
		m_Pending = true;
		m_Deadline = Now + 120000;
		return Request{m_Nonce, ++m_Serial};
	}
	bool Complete(const Request &Request, const std::string &EchoNonce,
		const AuthenticatedGameIdentity &Identity, int64_t Now)
	{
		if(!Clock(Now) || !Matches(Request))
			return false;
		m_Pending = false; // matching reply is terminal, including rejection
		if(Now >= m_Deadline || EchoNonce != m_Nonce || Identity.Domain != m_Domain ||
			!IsGameIdentityContextValid(Identity, Now) || Identity.AuthenticationExpiresAt > m_Deadline)
			return false;
		m_Identity = Identity;
		return true;
	}
	void Fail(const Request &Request)
	{
		if(Matches(Request))
		{
			m_Pending = false;
			m_Identity.reset();
		}
	}
	std::optional<std::string> PlayerId(int64_t Now)
	{
		if(!Active(Now))
			return std::nullopt;
		return m_Identity->PlayerId;
	}
	std::string SignChallenge(const MatchSigner &Signer, const std::string &Nonce,
		int64_t IssuedAt, int64_t ExpiresAt, const std::string &Bytes, int64_t Now)
	{
		if(!Active(Now))
			return {};
		return SignGameIdentityChallenge(Signer, *m_Identity, Nonce, IssuedAt, ExpiresAt, Bytes, Now);
	}

private:
	bool Clock(int64_t Now)
	{
		if(!m_Connected)
			return false;
		if(Now < m_LastNow || Now > 9007199254620991LL)
		{
			Disconnect(); // clock rollback/overflow cannot resurrect authentication
			return false;
		}
		m_LastNow = Now;
		return true;
	}
	bool Matches(const Request &Request) const
	{
		return m_Connected && m_Pending && Request.Serial == m_Serial && Request.Nonce == m_Nonce;
	}
	bool Active(int64_t Now)
	{
		if(!Clock(Now))
			return false;
		if(m_Identity && !IsGameIdentityContextValid(*m_Identity, Now))
			m_Identity.reset();
		return m_Identity.has_value();
	}
	bool m_Connected = true;
	bool m_Pending = false;
	uint64_t m_Serial = 0;
	int64_t m_Deadline = 0;
	int64_t m_LastNow = 0;
	std::string m_Nonce;
	std::string m_Domain;
	std::optional<AuthenticatedGameIdentity> m_Identity;
};
} // namespace neonrelay

#endif // NEONRELAY_GAME_CONNECTION_H
