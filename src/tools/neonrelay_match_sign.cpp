/* Neon Relay CLI helper (stage 8): signs match events exactly the way the
 * game server does, so reward-backend ingest can be exercised end to end
 * without running a game server.
 *
 * Usage:
 *   neonrelay_match_sign --seed-file PATH [--pubkey]
 *   neonrelay_match_sign --seed-hex HEX64 [--pubkey]
 *
 * The seed (32 bytes as 64 hex chars) may also come from the environment
 * variable NEONRELAY_SIGNING_SEED_HEX. It is never printed.
 *
 * Without --pubkey, tab-separated lines are read from stdin:
 *   match_id<TAB>player_id<TAB>event_type<TAB>amount_micro<TAB>occurred_at
 * and one ingest-format JSON line is written to stdout per input line,
 * byte-compatible with POST /v1/rewards/events on the reward backend.
 */
#include <cstdlib>
#include <cstring>
#include <iostream>
#include <sstream>
#include <string>

#include <neonrelay/match_signer.h>

int main(int argc, const char **argv)
{
	std::string seedHex;
	std::string seedFile;
	bool pubkeyOnly = false;

	for(int i = 1; i < argc; i++)
	{
		if(strcmp(argv[i], "--seed-hex") == 0 && i + 1 < argc)
			seedHex = argv[++i];
		else if(strcmp(argv[i], "--seed-file") == 0 && i + 1 < argc)
			seedFile = argv[++i];
		else if(strcmp(argv[i], "--pubkey") == 0)
			pubkeyOnly = true;
		else
		{
			std::cerr << "usage: neonrelay_match_sign (--seed-file PATH | --seed-hex HEX64) [--pubkey]" << std::endl;
			return 1;
		}
	}
	if(seedHex.empty() && seedFile.empty())
	{
		const char *pEnv = getenv("NEONRELAY_SIGNING_SEED_HEX");
		if(pEnv && pEnv[0])
			seedHex = pEnv;
	}

	neonrelay::MatchSigner signer;
	bool ok = false;
	if(!seedFile.empty())
		ok = signer.LoadSeedFile(seedFile);
	else if(!seedHex.empty())
		ok = signer.LoadSeedHex(seedHex);
	if(!ok)
	{
		std::cerr << "neonrelay_match_sign: no usable Ed25519 seed (need --seed-file, --seed-hex or NEONRELAY_SIGNING_SEED_HEX)" << std::endl;
		return 1;
	}

	if(pubkeyOnly)
	{
		std::cout << signer.PublicKeyBase64Url() << std::endl;
		return 0;
	}

	std::string line;
	int lineNumber = 0;
	while(std::getline(std::cin, line))
	{
		lineNumber++;
		if(line.empty())
			continue;
		// match_id \t player_id \t event_type \t amount_micro \t occurred_at
		std::string fields[5];
		size_t field = 0;
		size_t start = 0;
		while(start <= line.size())
		{
			size_t tab = line.find('\t', start);
			if(field >= 5)
			{
				std::cerr << "neonrelay_match_sign: line " << lineNumber << ": expected 5 tab-separated fields" << std::endl;
				return 1;
			}
			fields[field++] = line.substr(start, tab == std::string::npos ? std::string::npos : tab - start);
			if(tab == std::string::npos)
				break;
			start = tab + 1;
		}
		if(field != 5)
		{
			std::cerr << "neonrelay_match_sign: line " << lineNumber << ": expected 5 tab-separated fields, got " << field << std::endl;
			return 1;
		}
		int64_t amountMicro = strtoll(fields[3].c_str(), nullptr, 10);
		int64_t occurredAt = strtoll(fields[4].c_str(), nullptr, 10);
		const std::string canonical = neonrelay::CanonicalEventJson(fields[0], fields[1], fields[2], amountMicro, occurredAt);
		const std::string signature = signer.Sign(canonical);
		if(signature.empty())
		{
			std::cerr << "neonrelay_match_sign: signing failed at line " << lineNumber << std::endl;
			return 1;
		}
		std::ostringstream out;
		out << "{\"match_id\":\"" << neonrelay::JsonEscape(fields[0])
		    << "\",\"player_id\":\"" << neonrelay::JsonEscape(fields[1])
		    << "\",\"event_type\":\"" << neonrelay::JsonEscape(fields[2])
		    << "\",\"amount_micro\":" << amountMicro
		    << ",\"occurred_at\":" << occurredAt
		    << ",\"server_signature\":\"" << signature << "\"}";
		std::cout << out.str() << std::endl;
	}
	return 0;
}
