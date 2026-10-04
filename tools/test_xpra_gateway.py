import asyncio
import unittest

from xpra_gateway import connect, connection_token


def upgrade(token):
    return (f"GET /{token} HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\n"
            "Connection: keep-alive, Upgrade\r\nSec-WebSocket-Key: test\r\n\r\n").encode()


class XpraGatewayTests(unittest.IsolatedAsyncioTestCase):
    def test_only_exact_tokens_and_websocket_upgrades_are_accepted(self):
        token = "a" * 64
        self.assertEqual(connection_token(upgrade(token)), token)
        for value in ("", "../" + token, "vnc.html", token + "?other=1", "g" * 64):
            self.assertIsNone(connection_token(upgrade(value)))
        self.assertIsNone(connection_token(upgrade(token).replace(b"Upgrade: websocket", b"Upgrade: other")))

    async def test_upgrade_and_binary_payload_forward_only_to_authorized_session(self):
        received = []

        async def backend(reader, writer):
            try:
                received.append(await reader.readuntil(b"\r\n\r\n"))
                writer.write(b"HTTP/1.1 101 Switching Protocols\r\n\r\n")
                await writer.drain()
                while data := await reader.read(4096):
                    writer.write(data)
                    await writer.drain()
            finally:
                writer.close()

        target = await asyncio.start_server(backend, "127.0.0.1", 0)
        address = ("127.0.0.1", target.sockets[0].getsockname()[1])

        class Routes:
            def lookup(self, token):
                return address if token == "a" * 64 else None

        gateway = await asyncio.start_server(lambda r, w: connect(r, w, Routes()), "127.0.0.1", 0)
        port = gateway.sockets[0].getsockname()[1]
        try:
            reader, writer = await asyncio.open_connection("127.0.0.1", port)
            writer.write(upgrade("b" * 64))
            await writer.drain()
            self.assertIn(b"404", await reader.read())
            self.assertEqual(received, [])
            writer.close()
            await writer.wait_closed()
            reader, writer = await asyncio.open_connection("127.0.0.1", port)
            writer.write(upgrade("a" * 64))
            await writer.drain()
            self.assertIn(b"101", await reader.readuntil(b"\r\n\r\n"))
            binary = bytes(range(256)) * 20
            writer.write(binary)
            await writer.drain()
            self.assertEqual(await reader.readexactly(len(binary)), binary)
            self.assertTrue(received[0].startswith(b"GET / HTTP/1.1\r\n"))
            self.assertNotIn(b"a" * 64, received[0])
            writer.close()
            await writer.wait_closed()
        finally:
            gateway.close()
            target.close()
            await gateway.wait_closed()
            await target.wait_closed()


if __name__ == "__main__":
    unittest.main()
