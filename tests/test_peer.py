"""The same-user guard (peer.py): the client socket's owner, found by the whole connection in /proc/net/tcp."""
import os
import socket
import unittest

from office import peer

ME = os.getuid()
# 127.0.0.1 is 0100007F; 127.0.4.9 is 0904007F; the office listens on port 7428 (1D04).
TABLE = f"""  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:1D04 00000000:0000 0A 00000000:00000000 00:00000000 00000000  {ME}        0 1 1 0 100 0 0 10 0
   1: 0100007F:A001 0100007F:1D04 01 00000000:00000000 00:00000000 00000000  {ME}        0 2 1 0 20 4 30 10 -1
   2: 0100007F:A002 0100007F:1D04 01 00000000:00000000 00:00000000 00000000  {ME + 1}        0 3 1 0 20 4 30 10 -1
   3: 0100007F:A003 0100007F:1D04 06 00000000:00000000 00:00000000 00000000  {ME}        0 4 1 0 20 4 30 10 -1
   4: 0100007F:1D04 0904007F:1D04 01 00000000:00000000 00:00000000 00000000  {ME}        0 5 1 0 20 4 30 10 -1
   5: 0904007F:1D04 0100007F:1D04 01 00000000:00000000 00:00000000 00000000  {ME + 1}        0 6 1 0 20 4 30 10 -1
   6: 0100007F:A004 0100007F:1D04 05 00000000:00000000 00:00000000 00000000  {ME}        0 7 1 0 20 4 30 10 -1
   7: garbage
"""
SRV = ("127.0.0.1", 0x1D04)


class PeerTests(unittest.TestCase):
    def test_owner_of_the_client_end(self):
        self.assertEqual(peer.peer_uid(("127.0.0.1", 0xA001), SRV, TABLE), ME)
        self.assertTrue(peer.same_user(("127.0.0.1", 0xA001), SRV, TABLE))
        self.assertFalse(peer.same_user(("127.0.0.1", 0xA002), SRV, TABLE))     # another account
        self.assertFalse(peer.same_user(("127.0.0.1", 0xA003), SRV, TABLE))     # a closed connection
        self.assertFalse(peer.same_user(("127.0.0.1", 0xBEEF), SRV, TABLE))     # not listed: refused
        self.assertTrue(peer.same_user(("127.0.0.1", 0xA004), SRV, TABLE))      # half-closed after its request: still mine

    def test_a_source_port_equal_to_the_offices_is_not_the_offices_socket(self):
        # Another account binds 127.0.4.9:7428 and connects to the office: rows 4 (the office's accepted socket, ours)
        # and 5 (theirs) share both port numbers. Only the whole connection picks theirs.
        self.assertEqual(peer.peer_uid(("127.0.4.9", 0x1D04), SRV, TABLE), ME + 1)
        self.assertFalse(peer.same_user(("127.0.4.9", 0x1D04), SRV, TABLE))

    @unittest.skipUnless(os.path.exists("/proc/net/tcp"), "Linux only")
    def test_a_real_loopback_connection_is_mine(self):
        srv = socket.socket(); srv.bind(("127.0.0.1", 0)); srv.listen(1)
        cli = socket.create_connection(srv.getsockname())
        conn, addr = srv.accept()
        try:
            self.assertTrue(peer.same_user(addr, conn.getsockname()))
            self.assertFalse(peer.same_user((addr[0], addr[1] + 1 if addr[1] < 65535 else 1), conn.getsockname()))
        finally:
            conn.close(); cli.close(); srv.close()


if __name__ == "__main__":
    unittest.main()
