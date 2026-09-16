package com.leo88q.neonrelay.wallet

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class WalletSessionTest {
    @Test
    fun `starts disconnected without an account`() {
        val session = WalletSession(InMemoryWalletSessionStore())
        assertEquals(WalletSession.State.DISCONNECTED, session.snapshot.value.state)
        assertNull(session.snapshot.value.account)
    }

    @Test
    fun `connecting stores the account and persists the public key`() {
        val store = InMemoryWalletSessionStore()
        val session = WalletSession(store)
        val account = WalletAccount(byteArrayOf(1, 2, 3), "tester")
        session.update(WalletSession.State.CONNECTED, account)
        assertEquals(WalletSession.State.CONNECTED, session.snapshot.value.state)
        assertEquals(account, session.snapshot.value.account)
        assertEquals("tester", store.accountLabel)
        assertEquals(3, store.accountPublicKey?.size)
    }

    @Test
    fun `disconnecting drops the auth token but keeps the account for the UI`() {
        val store = InMemoryWalletSessionStore()
        val session = WalletSession(store)
        session.authToken = "token"
        session.update(WalletSession.State.CONNECTED, WalletAccount(byteArrayOf(9), null))
        session.update(WalletSession.State.DISCONNECTED)
        assertNull(store.authToken)
        assertEquals(WalletSession.State.DISCONNECTED, session.snapshot.value.state)
        assertEquals(byteArrayOf(9).toList(), session.snapshot.value.account?.publicKey?.toList())
    }

    @Test
    fun `a restored session shows the bound account before reconnecting`() {
        val store = InMemoryWalletSessionStore()
        store.accountPublicKey = byteArrayOf(4, 5)
        store.accountLabel = "restored"
        val session = WalletSession(store)
        assertEquals(WalletSession.State.DISCONNECTED, session.snapshot.value.state)
        assertEquals("restored", session.snapshot.value.account?.label)
    }

    @Test
    fun `forgetting clears everything`() {
        val store = InMemoryWalletSessionStore()
        val session = WalletSession(store)
        session.update(WalletSession.State.CONNECTED, WalletAccount(byteArrayOf(7), "x"))
        session.clear()
        assertNull(store.accountPublicKey)
        assertNull(session.snapshot.value.account)
    }
}
