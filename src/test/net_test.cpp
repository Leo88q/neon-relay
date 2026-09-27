#include <base/mem.h>
#include <base/net.h>
#include <base/secure.h>

#include <gtest/gtest.h>

#include <chrono>

using namespace std::chrono_literals;

TEST(Net, Ipv4AndIpv6Work)
{
	NETADDR Bindaddr = {};
	NETSOCKET Socket1;
	NETSOCKET Socket2;

	Bindaddr.type = NETTYPE_IPV4 | NETTYPE_IPV6;
	Socket2 = net_udp_create(Bindaddr);
	// The random port must be free for both address families: on a busy
	// machine one family can bind while the other hits EADDRINUSE, and
	// net_udp_create only returns nullptr when neither bound, so a partial
	// socket would silently drop the IPv4 leg of this test. Retry until both
	// families are up instead of accepting the first non-null socket.
	Socket1 = nullptr;
	for(int Attempts = 0; Attempts < 64 && Socket1 == nullptr; Attempts++)
	{
		Bindaddr.port = secure_rand_below(65535 - 1024) + 1024;
		NETSOCKET Candidate = net_udp_create(Bindaddr);
		if(Candidate == nullptr)
		{
			continue;
		}
		if((net_socket_type(Candidate) & (NETTYPE_IPV4 | NETTYPE_IPV6)) == (NETTYPE_IPV4 | NETTYPE_IPV6))
		{
			Socket1 = Candidate;
		}
		else
		{
			net_udp_close(Candidate);
		}
	}
	ASSERT_TRUE(Socket1 != nullptr) << "could not bind a free dual-stack UDP port";

	NETADDR LocalhostV4;
	NETADDR LocalhostV6;
	NETADDR TargetV4;
	NETADDR TargetV6;
	ASSERT_FALSE(net_addr_from_str(&LocalhostV4, "127.0.0.1"));
	ASSERT_FALSE(net_addr_from_str(&LocalhostV6, "[::1]"));
	TargetV4 = LocalhostV4;
	TargetV6 = LocalhostV6;
	TargetV4.port = Bindaddr.port;
	TargetV6.port = Bindaddr.port;

	NETADDR Addr;
	unsigned char *pData;

	EXPECT_EQ(net_udp_send(Socket2, &TargetV4, "abc", 3), 3);

	EXPECT_EQ(net_socket_read_wait(Socket1, 10s), 1);
	ASSERT_EQ(net_udp_recv(Socket1, &Addr, &pData), 3);
	Addr.port = 0;
	EXPECT_EQ(Addr, LocalhostV4);
	EXPECT_EQ(mem_comp(pData, "abc", 3), 0);

	EXPECT_EQ(net_udp_send(Socket2, &TargetV6, "def", 3), 3);

	EXPECT_EQ(net_socket_read_wait(Socket1, 10s), 1);
	ASSERT_EQ(net_udp_recv(Socket1, &Addr, &pData), 3);
	Addr.port = 0;
	EXPECT_EQ(Addr, LocalhostV6);
	EXPECT_EQ(mem_comp(pData, "def", 3), 0);

	net_udp_close(Socket1);
	net_udp_close(Socket2);
}
