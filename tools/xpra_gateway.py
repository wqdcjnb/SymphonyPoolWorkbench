"""Loopback-only WebSocket gateway to a live, account-specific Xpra session."""

import argparse
import asyncio
import re
import sys

from desktop_routes import DesktopRoutes


def connection_token(header):
    """Only accept native Xpra WebSocket upgrades with an exact bearer path."""
    try:
        lines = header.decode("ascii").split("\r\n")
        method, target, version = lines[0].split(" ")
        match = re.fullmatch(r"/([a-f0-9]{64})/?", target)
        fields = {}
        for line in lines[1:]:
            if line:
                name, value = line.split(":", 1)
                fields[name.strip().lower()] = value.strip()
        if (method != "GET" or version != "HTTP/1.1" or not match
                or fields.get("upgrade", "").lower() != "websocket"
                or "upgrade" not in [v.strip() for v in fields.get("connection", "").lower().split(",")]
                or not fields.get("sec-websocket-key")):
            return None
        return match[1]
    except (UnicodeError, ValueError):
        return None


async def pump(reader, writer):
    while data := await reader.read(65536):
        writer.write(data)
        await writer.drain()


async def connect(reader, writer, routes):
    upstream = None
    transfers = []
    try:
        header = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), timeout=8)
        if len(header) > 16384:
            raise ValueError("header too long")
        token = connection_token(header)
        target = routes.lookup(token)
        if not target:
            print("XPRA_GATEWAY_REJECT", "invalid_upgrade" if not token else "expired_session", file=sys.stderr, flush=True)
            writer.write(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            await writer.drain()
            return
        remote, upstream = await asyncio.wait_for(asyncio.open_connection(*target), timeout=5)
        # Xpra receives a plain upgrade; the session bearer is consumed here.
        upstream.write(b"GET / HTTP/1.1\r\n" + header.split(b"\r\n", 1)[1])
        await upstream.drain()
        transfers = [asyncio.create_task(pump(reader, upstream)), asyncio.create_task(pump(remote, writer))]
        await asyncio.wait(transfers, return_when=asyncio.FIRST_COMPLETED)
    except (ValueError, OSError, TimeoutError, asyncio.IncompleteReadError, asyncio.LimitOverrunError) as error:
        print("XPRA_GATEWAY_ERROR", type(error).__name__, file=sys.stderr, flush=True)
    finally:
        for task in transfers:
            task.cancel()
        if transfers:
            await asyncio.gather(*transfers, return_exceptions=True)
        for connection in (upstream, writer):
            if connection:
                connection.close()
                try:
                    await connection.wait_closed()
                except OSError:
                    pass


async def serve(root, port):
    routes = DesktopRoutes(root)
    server = await asyncio.start_server(lambda r, w: connect(r, w, routes), "127.0.0.1", port, limit=16384)
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True)
    parser.add_argument("--port", type=int, default=6080)
    args = parser.parse_args()
    asyncio.run(serve(args.root, args.port))
