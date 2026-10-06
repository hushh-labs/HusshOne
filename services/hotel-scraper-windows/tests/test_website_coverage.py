import gzip
import zlib
from types import SimpleNamespace

import brotli
import pytest

from app import website_enrichment as web
from app.config import database_target, settings
from app.website_backfill import fill_candidates
from app.website_queue import WebsiteQueue
from app.website_discovery import maps_identity_url
from tests.test_website_enrichment import RECORD, NODE, html, fixture_fetch


@pytest.mark.parametrize('encoding,compress', [('gzip', gzip.compress), ('deflate', zlib.compress), ('br', brotli.compress)])
def test_compression_supported_and_expansion_bounded(encoding, compress):
    assert web.decode_body(compress(b'<html>Hotel</html>'), encoding, 100) == b'<html>Hotel</html>'
    with pytest.raises(web.WebsiteBlocked, match='size limit'):
        web.decode_body(compress(b'a' * 10000), encoding, 100)


@pytest.mark.parametrize('encoding', ['gzip', 'deflate', 'br'])
def test_invalid_compression_rejected(encoding):
    with pytest.raises(web.WebsiteBlocked):
        web.decode_body(b'bad compressed data', encoding, 1000)


def visible(phone='206-555-1234', name='Cedar Hotel'):
    return (f'<h1>{name}</h1><a href="tel:{phone}">Reception</a>'
            '<address>1 Main St, Kirkland, WA 98033</address>'
            '<p>Free Wi-Fi</p><p>Check-in from 3 pm</p>').encode()


def crawl(pages):
    return web.crawl_website(RECORD, fixture_fetch(pages), sleep=lambda _: None)


def test_visible_contact_can_verify_and_fill_blanks():
    result = crawl({RECORD['website']: visible()})
    assert result['status'] == 'collected'
    assert result['fields']['address']['extraction'] == 'visible_contact'
    assert result['fields']['amenityStatements']['value'] == ['Free Wi-Fi']
    row = SimpleNamespace(name=RECORD['name'], website=RECORD['website'], phone=RECORD['phone'],
                          formatted_address=RECORD['formatted_address'], lat=None, lng=None, zip=None, state=None)
    fills = fill_candidates(row, result)
    assert set(fills) == {'zip', 'state'}
    assert fills['zip'][0] == '98033'
    # Recheck against current row; never fill from stale identity proof.
    row.phone = '2065559999'
    assert fill_candidates(row, result) == {}


def test_visible_name_or_conflicting_phone_not_enough():
    assert crawl({RECORD['website']: b'<h1>Cedar Hotel</h1>'})['status'] == 'needs_review'
    assert crawl({RECORD['website']: visible('2065559999')})['status'] == 'needs_review'
    assert crawl({RECORD['website']: visible(name='Another Hotel')})['status'] == 'needs_review'


def test_ambiguous_visible_phones_not_filled():
    body = visible() + b'<a href="tel:2065559999">Corporate reservations</a>'
    result = crawl({RECORD['website']: body})
    assert result['status'] == 'collected'  # exact name plus known postal code
    assert 'telephone' not in result['fields']


def test_contact_page_adds_verified_fields_missing_on_landing():
    body = html({**NODE, 'telephone': RECORD['phone']}, '<a href="/contact">Contact</a>')
    result = crawl({RECORD['website']: body, 'https://hotel.example/contact': visible()})
    assert result['fields']['address']['source_url'].endswith('/contact')
    assert result['fields']['telephone']['extraction'] == 'json_ld'


def test_chain_contact_page_cannot_add_unverified_fields():
    result = crawl({RECORD['website']: html(links='<a href="/contact">Contact</a>'),
                    'https://hotel.example/contact': visible(name='Hotel Corporate Office')})
    assert 'address' not in result['fields']


def test_secondary_page_denial_preserves_verified_evidence():
    result = crawl({RECORD['website']: html(links='<a href="/contact">Contact</a>'),
                    'https://hotel.example/contact': (403, {}, b'')})
    assert result['status'] == 'collected'
    assert result['partial_collection'] is True
    assert result['fields']['telephone']['value'] == NODE['telephone']


def test_redirect_loop_detected_before_repeat_fetch():
    calls = []
    def fetch(url):
        calls.append(url)
        return (404, {}, b'') if url.endswith('/robots.txt') else (302, {'location': '/'}, b'')
    result = web.crawl_website(RECORD, fetch, sleep=lambda _: None)
    assert result['status'] == 'blocked'
    assert 'loop' in result['reason']
    assert calls.count(RECORD['website']) == 1


def test_permanent_official_redirect_requires_identity_and_new_robots_check():
    pages = {RECORD['website']: (301, {'location': 'https://new-hotel.example/'}, b''),
             'https://new-hotel.example/': visible()}
    result = crawl(pages)
    assert result['status'] == 'collected'
    assert result['redirects'][0]['to'] == 'https://new-hotel.example/'
    assert result['fields']['address']['source_url'] == 'https://new-hotel.example/'
    # New-domain evidence is retained, but cannot implicitly change stored URL
    # or fill canonical fields from a different hostname.
    row = SimpleNamespace(name=RECORD['name'], website=RECORD['website'], phone=RECORD['phone'],
                          formatted_address=RECORD['formatted_address'], lat=None, lng=None, zip=None, state=None)
    assert fill_candidates(row, result) == {}
    pages['https://new-hotel.example/'] = visible(name='Other Property')
    assert crawl(pages)['status'] == 'needs_review'
    pages['https://new-hotel.example/robots.txt'] = (200, {}, b'User-agent: *\nDisallow: /\n')
    fetch = fixture_fetch(pages)
    assert web.crawl_website(RECORD, lambda url: pages[url] if url.endswith('new-hotel.example/robots.txt') else fetch(url),
                            sleep=lambda _: None)['status'] == 'blocked'


def test_legacy_maps_cid_url_can_discover_website():
    assert maps_identity_url({'google_maps_uri': 'https://maps.google.com/?cid=123&g_mp=x'}) == 'https://www.google.com/maps?cid=123'
    with pytest.raises(web.WebsiteBlocked):
        maps_identity_url({'google_maps_uri': 'https://evil.example/?cid=123'})


def test_recoverable_legacy_jobs_requeued_once_without_resetting_fetched(tmp_path):
    path = tmp_path / 'queue.db'
    queue = WebsiteQueue(path)
    queue.enqueue(RECORD, 'r', database_target())
    job = queue.next_job()
    queue.save_result(job, {'status': 'blocked', 'reason': 'Unsupported compressed website response'})
    queue.finish(job['id'])
    with queue.connect() as c:
        c.execute("DELETE FROM website_queue_upgrades WHERE version='coverage-v2'")
    queue = WebsiteQueue(path)
    assert queue.next_job()['state'] == 'pending'
    queue.save_result(queue.next_job(), {'status': 'collected', 'fields': {}})
    queue = WebsiteQueue(path)
    assert queue.next_job()['state'] == 'fetched'
    queue.finish(job['id'])
    assert WebsiteQueue(path).next_job() is None


def test_priority_prefers_incomplete_direct_website_without_losing_discovery(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, 'WEBSITE_FILL_MISSING_FIELDS', True)
    queue = WebsiteQueue(tmp_path / 'queue.db')
    queue.enqueue({**RECORD, 'dedup_key': 'discovery', '_discover_website': True}, 'r', database_target())
    queue.enqueue({**RECORD, 'dedup_key': 'complete', 'phone': 'x', 'formatted_address': 'x', 'zip': '98033', 'state': 'WA'}, 'r', database_target())
    queue.enqueue({**RECORD, 'dedup_key': 'incomplete', 'phone': None}, 'r', database_target())
    assert queue.next_job()['payload']['record']['dedup_key'] == 'incomplete'
    assert queue.counts() == {'pending': 3}


def test_restrictions_cached_for_exact_url_and_survive_restart(tmp_path):
    path = tmp_path / 'queue.db'
    queue = WebsiteQueue(path)
    queue.enqueue(RECORD, 'r', database_target())
    job = queue.next_job()
    queue.enqueue({**RECORD, 'dedup_key': 'same-url'}, 'r', database_target())
    queue.save_result(job, {'status': 'blocked', 'reason': 'Website restricted (HTTP 403); no bypass attempted'})
    queue.finish(job['id'])
    queue = WebsiteQueue(path)
    queue.enqueue({**RECORD, 'dedup_key': 'new-observation'}, 'r', database_target())
    assert queue.next_job() is None
    assert queue.scheduler_status()['waiting_retry'] == 2
    queue.enqueue({**RECORD, 'dedup_key': 'other-property', 'website': 'https://hotel.example/other'}, 'r', database_target())
    assert queue.next_job()['payload']['record']['dedup_key'] == 'other-property'
    assert queue.metrics()['cached_restrictions'] == 1


def test_restriction_expiry_and_unique_profile_metrics(tmp_path):
    queue = WebsiteQueue(tmp_path / 'queue.db')
    for timestamp in ('first', 'second'):
        queue.enqueue({**RECORD, 'raw': {'scraped_at': timestamp}}, 'r', database_target())
        job = queue.next_job()
        queue.save_result(job, {'status': 'collected', 'scraped_via': 'business_website',
                               'requested_url': RECORD['website'], 'pages': [{'url': RECORD['website']}], 'fields': {}})
        queue.finish(job['id'])
    metrics = queue.metrics()
    assert metrics['verified_profiles'] == 1
    assert metrics['corroborated_jobs'] == 2
    assert metrics['websites_reached'] == 1
    with queue.connect() as c:
        c.execute('INSERT INTO website_access_cache VALUES(?,?,?,?)',
                  (database_target()['fingerprint'], RECORD['website'], 1, 'expired'))
    queue.enqueue({**RECORD, 'dedup_key': 'after-expiry'}, 'r', database_target())
    assert queue.next_job()['payload']['record']['dedup_key'] == 'after-expiry'


def test_age_prevents_permanent_discovery_starvation(tmp_path):
    queue = WebsiteQueue(tmp_path / 'queue.db')
    queue.enqueue({**RECORD, 'dedup_key': 'discovery', '_discover_website': True}, 'r', database_target())
    with queue.connect() as c:
        c.execute('UPDATE website_jobs SET updated_at=1')
    queue.enqueue({**RECORD, 'dedup_key': 'direct'}, 'r', database_target())
    assert queue.next_job()['payload']['record']['dedup_key'] == 'discovery'
