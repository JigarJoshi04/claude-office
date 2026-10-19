"""The same-user guard (peer.py): the client socket's owner, from a /proc/net/tcp table."""
import os
import socket
import unittest

from office import peer

ME = os.getuid()
TABLE = f"""  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:1D04 00000000:0000 0A 00000000:00000000 00:00000000 00000000  {ME}        0 1 1 0 100 0 0 10 0
   1: 0100007F:A001 0100007F:1D04 01 00000000:00000000 00:00000000 00000000  {ME}        0 2 1 0 20 4 30 10 -1
   2: 0100007F:A002 0100007F:1D04 01 00000000:00000000 00:00000000 00000000  {ME + 1}        0 3 1 0 20 4 30 10 -1
   3: 0100007F:A003 0100007F:1D04 06 00000000:00000000 00:00000000 00000000  {ME}        0 4 1 0 20 4 30 10 -1
   4: garbage
"""


class PeerTests(unittest.TestCase):
    def test_owner_of_the_client_end(self):
        self.assertEqual(peer.peer_uid(0xA001, 0x1D04, TABLE), ME)
        self.assertTrue(peer.same_user(0xA001, 0x1D04, TABLE))
        self.assertFalse(peer.same_user(0xA002, 0x1D04, TABLE))           # another account
        self.assertFalse(peer.same_user(0xA003, 0x1D04, TABLE))           # not an open connection
        self.assertFalse(peer.same_user(0xBEEF, 0x1D04, TABLE))           # not listed: refused

    @unittest.skipUnless(os.path.exists("/proc/net/tcp"), "Linux only")
    def test_a_real_loopback_connection_is_mine(self):
        srv = socket.socket(); srv.bind(("127.0.0.1", 0)); srv.listen(1)
        cli = socket.create_connection(srv.getsockname())
        conn, addr = srv.accept()
        try:
            self.assertTrue(peer.same_user(addr[1], srv.getsockname()[1]))
        finally:
            conn.close(); cli.close(); srv.close()


if __name__ == "__main__":
    unittest.main()
