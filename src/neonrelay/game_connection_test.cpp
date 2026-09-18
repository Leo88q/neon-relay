// Test-only game-thread state machine harness; no networking or private keys.
#include "game_connection.h"
#include <cassert>
#include <memory>

int main()
{
	using namespace neonrelay;
	std::array<unsigned char, 32> Random{};
	Random.fill(7);
	auto Connection = std::make_shared<GameConnectionIdentity>(Random);
	assert(Connection->Nonce() == std::string("0707070707070707070707070707070707070707070707070707070707070707"));
	AuthenticatedGameIdentity Context;
	Context.Domain = "game.example";
	Context.PlayerId = "registered-account";
	Context.Wallet = std::string(43, 'A'); // public encoding fixture only
	Context.SessionId = "12345678-1234-1234-1234-123456789abc";
	Context.WalletBindingId = "abcdef01-1234-1234-1234-123456789abc";
	Context.AuthenticationExpiresAt = 5000;
	Context.ExplicitLinkConfirmed = true;
	assert(!Connection->PlayerId(1000));
	const auto First = Connection->Begin(Context.Domain, 1000).value();
	const auto Second = Connection->Begin(Context.Domain, 1000).value();
	assert(!Connection->Complete(First, First.Nonce, Context, 1100));
	Connection->Fail(First); // old failure must not cancel the current attempt
	assert(Connection->Complete(Second, Second.Nonce, Context, 1100));
	assert(Connection->PlayerId(1100).value() == Context.PlayerId);
	assert(!Connection->Complete(Second, Second.Nonce, Context, 1100));
	const auto Third = Connection->Begin(Context.Domain, 1100).value();
	assert(!Connection->PlayerId(1100)); // starting re-pairing clears old identity
	assert(!Connection->Complete(Third, "wrong", Context, 1200));
	assert(!Connection->Complete(Third, Third.Nonce, Context, 1200));
	const auto Fourth = Connection->Begin(Context.Domain, 1200).value();
	assert(Connection->Complete(Fourth, Fourth.Nonce, Context, 1200));
	assert(!Connection->PlayerId(5000)); // exact expiry is not live
	assert(!Connection->PlayerId(4000)); // time rollback cannot resurrect it
	assert(!Connection->Begin(Context.Domain, 5000));

	for(int Variant = 0; Variant < 6; ++Variant)
	{
		GameConnectionIdentity Fresh(Random);
		const auto Request = Fresh.Begin(Context.Domain, 1000).value();
		auto Bad = Context;
		if(Variant == 0) Bad.Domain = "evil.example";
		if(Variant == 1) Bad.Wallet = "bad";
		if(Variant == 2) Bad.ExplicitLinkConfirmed = false;
		if(Variant == 3) Bad.AuthenticationExpiresAt = 999999;
		if(Variant == 4) Bad.SessionId = "bad";
		if(Variant == 5) Bad.AuthenticationExpiresAt = 1000;
		assert(!Fresh.Complete(Request, Request.Nonce, Bad, 1000));
		assert(!Fresh.PlayerId(1000));
	}
	GameConnectionIdentity Timeout(Random);
	const auto Expiring = Timeout.Begin(Context.Domain, 1000).value();
	assert(!Timeout.Complete(Expiring, Expiring.Nonce, Context, 121000));

	Connection = std::make_shared<GameConnectionIdentity>(Random);
	const auto OldRequest = Connection->Begin(Context.Domain, 1000).value();
	std::weak_ptr<GameConnectionIdentity> Weak = Connection;
	auto RetainedOld = Connection; // even a mistakenly retained strong handle is inert
	Connection->Disconnect();
	Random.fill(8);
	Connection = std::make_shared<GameConnectionIdentity>(Random); // reused client slot
	assert(!RetainedOld->Complete(OldRequest, OldRequest.Nonce, Context, 1100));
	const auto NewRequest = Connection->Begin(Context.Domain, 1100).value();
	assert(!Connection->Complete(OldRequest, OldRequest.Nonce, Context, 1100));
	assert(Connection->Complete(NewRequest, NewRequest.Nonce, Context, 1100));
	RetainedOld.reset();
	assert(Weak.expired());
	Connection->Disconnect();
	assert(!Connection->PlayerId(1100));
	assert(!Connection->Begin(Context.Domain, 1100));
#if !defined(CONF_OPENSSL)
	GameConnectionIdentity Unsupported(Random);
	MatchSigner Signer;
	assert(Signer.LoadSeedHex(std::string(64, '1')));
	assert(!Unsupported.BeginSealedPairing(Signer, "game.example", 1000));
	assert(Unsupported.OpenSealedPairing("{}", 1000).empty());
#endif
	return 0;
}
