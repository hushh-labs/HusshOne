"""Bounded JSON response compression; auth headers and request bodies untouched."""
import gzip
import brotli
import zstandard


def negotiate(header):
    quality = {}
    for part in header.split(','):
        bits = [bit.strip() for bit in part.split(';')]
        name = bits[0].lower()
        q = 1.0
        for bit in bits[1:]:
            if bit.startswith('q='):
                try:
                    q = float(bit[2:])
                except ValueError:
                    q = 0
        quality[name] = q if 0 <= q <= 1 else 0
    identity = quality.get('identity', 0 if quality.get('*') == 0 else 1)
    supported = [(quality.get(name, quality.get('*', 0)), name) for name in ('gzip','br','zstd')]
    q, name = max(supported, key=lambda pair:(pair[0], ('gzip','br','zstd').index(pair[1])))
    if q > 0 and ('identity' not in quality or q >= identity):
        return name, identity > 0
    return ('identity' if identity > 0 else None), identity > 0


class Compression:
    def __init__(self, app, enabled=True):
        self.app = app
        self.enabled = enabled

    async def __call__(self, scope, receive, send):
        if scope['type'] != 'http':
            return await self.app(scope, receive, send)
        request_headers = dict(scope.get('headers', []))
        if request_headers.get(b'content-encoding', b'identity') != b'identity':
            await send({'type':'http.response.start','status':415,'headers':[]})
            await send({'type':'http.response.body','body':b'Search requests must be uncompressed JSON'})
            return
        if scope.get('method') == 'POST':
            request_chunks, request_size = [], 0
            original_receive = receive
            while True:
                message = await original_receive()
                if message['type'] == 'http.disconnect':
                    return
                request_size += len(message.get('body', b''))
                if request_size > 8192:
                    await send({'type':'http.response.start','status':413,'headers':[]})
                    await send({'type':'http.response.body','body':b'Search request too large'})
                    return
                request_chunks.append(message.get('body', b''))
                if not message.get('more_body'):
                    break
            cached = b''.join(request_chunks)
            delivered = False
            async def bounded_receive():
                nonlocal delivered
                if delivered:
                    return await original_receive()
                delivered = True
                return {'type':'http.request','body':cached,'more_body':False}
            receive = bounded_receive
        accept = dict(scope.get('headers', [])).get(b'accept-encoding', b'').decode('latin1')
        encoding, identity_allowed = negotiate(accept)
        if not self.enabled:
            encoding = 'identity' if identity_allowed else None
        if encoding is None:
            await send({'type':'http.response.start', 'status':406, 'headers':[(b'vary',b'Accept-Encoding')]})
            await send({'type':'http.response.body', 'body':b''})
            return
        start, chunks, size, rejected = None, [], 0, False
        async def compressed_send(message):
            nonlocal start, size, rejected
            if rejected:
                return
            if message['type'] == 'http.response.start':
                start = message
                return
            if message['type'] != 'http.response.body':
                return await send(message)
            size += len(message.get('body', b''))
            if size > 8 * 1024**2:
                rejected = True
                chunks.clear()
                await send({'type':'http.response.start','status':413,'headers':[]})
                await send({'type':'http.response.body','body':b'Response too large; reduce limit'})
                return
            chunks.append(message.get('body', b''))
            if message.get('more_body'):
                return
            body = b''.join(chunks)
            headers = list(start.get('headers', []))
            existing = dict(headers)
            # Search is bounded to 100 records; reject unexpected huge output.
            if len(body) > 8 * 1024**2:
                await send({'type':'http.response.start','status':413,'headers':[]})
                await send({'type':'http.response.body','body':b'Response too large; reduce limit'})
                return
            if encoding != 'identity' and (len(body) >= 1024 or not identity_allowed) and b'content-encoding' not in existing and start['status'] not in (204,304):
                if encoding == 'zstd':
                    body = zstandard.ZstdCompressor(level=3).compress(body)
                elif encoding == 'br':
                    body = brotli.compress(body, quality=4)
                else:
                    body = gzip.compress(body, compresslevel=5)
                headers.append((b'content-encoding',encoding.encode()))
            vary = existing.get(b'vary',b'').decode('latin1')
            headers = [(k,v) for k,v in headers if k.lower() not in (b'content-length',b'vary')]
            headers.extend([(b'content-length',str(len(body)).encode()), (b'vary', (vary + ', Accept-Encoding' if vary else 'Accept-Encoding').encode())])
            await send({**start,'headers':headers})
            await send({'type':'http.response.body','body':body})
        await self.app(scope, receive, compressed_send)
