import asyncio
import gzip
import brotli
import zstandard
import pytest
from fastapi.testclient import TestClient
from cloud_api.main import app
from cloud_api.compression import Compression, negotiate


def test_cloud_app_does_not_expose_desktop_controls():
    client = TestClient(app)
    assert client.get('/health').status_code == 200
    for path in ('/api/control/start','/api/directory-fleet/hotel/start','/api/worker-updates/apply'):
        assert client.post(path).status_code == 404
    assert client.get('/api/v1/businesses').status_code == 422
    assert client.get('/api/v1/businesses?q=x&limit=101').status_code == 422


@pytest.mark.parametrize('encoding,decoder', [('gzip',gzip.decompress),('br',brotli.decompress),('zstd',lambda body:zstandard.ZstdDecompressor().decompress(body))])
def test_compression_roundtrip(encoding, decoder):
    body = b'{"public_fields":"' + b'Hotel directory business fields ' * 200 + b'"}'
    async def endpoint(scope, receive, send):
        await send({'type':'http.response.start','status':200,'headers':[(b'content-type',b'application/json')]})
        await send({'type':'http.response.body','body':body})
    messages = []
    async def send(message):
        messages.append(message)
    asyncio.run(Compression(endpoint)({'type':'http','headers':[(b'accept-encoding',encoding.encode())]},None,send))
    assert dict(messages[0]['headers'])[b'content-encoding'] == encoding.encode()
    assert decoder(messages[1]['body']) == body
    assert len(messages[1]['body']) < len(body)
    assert dict(messages[0]['headers'])[b'vary'] == b'Accept-Encoding'


def test_encoding_quality_and_identity_rules():
    assert negotiate('gzip;q=1, br;q=0, zstd;q=0')[0] == 'gzip'
    assert negotiate('gzip;q=0.1, identity;q=1')[0] == 'identity'
    assert negotiate('gzip;q=0, br;q=0, zstd;q=0, identity;q=0')[0] is None
    assert negotiate('')[0] == 'identity'


def test_search_request_size_and_encoding_are_bounded():
    client = TestClient(app)
    assert client.post('/api/v1/businesses/search', content=b'x' * 8193).status_code == 413
    assert client.post('/api/v1/businesses/search', content=b'x', headers={'Content-Encoding':'gzip'}).status_code == 415
    assert client.get('/health', headers={'Accept-Encoding':'*;q=0, identity;q=0'}).status_code == 406
