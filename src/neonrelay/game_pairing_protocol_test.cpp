// Test-only protocol harness. Not a production signing endpoint.
#include "game_pairing_protocol.h"
#include <iostream>
#include <iterator>

int main(int argc, char **argv)
{
	if(argc < 2) return 2;
	const std::string Mode = argv[1];
	if(Mode == "request" && argc == 3)
	{
		neonrelay::MatchSigner Signer;
		if(!Signer.LoadSeedFile(argv[2])) return 2;
		std::string Domain, Nonce, Token;
		if(!std::getline(std::cin, Domain) || !std::getline(std::cin, Nonce) || !std::getline(std::cin, Token)) return 2;
		const auto Result = neonrelay::PairingRequestJson(Signer, Domain, Nonce, Token);
		if(Result.empty()) return 3;
		std::cout << Result;
		return 0;
	}
	const std::string Input((std::istreambuf_iterator<char>(std::cin)), std::istreambuf_iterator<char>());
	if(Mode == "origin") return neonrelay::IsPairingOrigin(Input) ? 0 : 3;
	if(Mode == "envelope" && argc == 3)
	{
		neonrelay::PairingEnvelope Envelope;
		return neonrelay::ParsePairingEnvelope(Input, Envelope, std::stoll(argv[2])) ? 0 : 3;
	}
	if(Mode == "parse" && argc == 3)
	{
		neonrelay::AuthenticatedGameIdentity Context;
		std::string Nonce;
		if(!neonrelay::ParsePairingResponse(Input, Context, Nonce, std::stoll(argv[2]))) return 3;
		std::cout << Context.PlayerId;
		return 0;
	}
	return 2;
}
