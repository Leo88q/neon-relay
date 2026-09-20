// Test-only harness, never a deployed signing endpoint or production tool.
#include "game_identity.h"
#include <iostream>
#include <string>

int main(int argc, char **argv)
{
	if(argc != 2)
		return 2;
	neonrelay::MatchSigner Signer;
	if(!Signer.LoadSeedFile(argv[1]))
		return 2;
	neonrelay::AuthenticatedGameIdentity Identity;
	std::string Nonce, Raw, Issued, Expires, Now, AuthExpires, Consent;
	for(std::string *pField : {&Identity.Domain, &Identity.PlayerId, &Identity.Wallet,
		&Identity.SessionId, &Identity.WalletBindingId, &Nonce, &Issued, &Expires, &Now, &AuthExpires, &Consent, &Raw})
		if(!std::getline(std::cin, *pField))
			return 2;
	try
	{
		Identity.AuthenticationExpiresAt = std::stoll(AuthExpires);
		Identity.ExplicitLinkConfirmed = Consent == "yes";
		const auto Signature = neonrelay::SignGameIdentityChallenge(Signer, Identity, Nonce,
			std::stoll(Issued), std::stoll(Expires), Raw, std::stoll(Now));
		if(Signature.empty())
			return 3;
		std::cout << Signature << '\n';
	}
	catch(...)
	{
		return 2;
	}
	return 0;
}
