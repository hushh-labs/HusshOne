import pytest
from pydantic import ValidationError
from fastapi.testclient import TestClient
from app.business_onboarding import (OnboardingLookup, normalize_phone, website_domain,
                                     build_resolution, resolve_with_sessions)


def request(email='owner@example.com'):
    return OnboardingLookup(work_email=email, phone='+1 (425) 555-0100')


def row(**changes):
    return dict(id=1, name='Example business', phone='425-555-0100',
                website='https://www.example.com/about', **changes)


def test_normalization():
    assert request().phone == '4255550100'
    assert website_domain('https://www.Example.com/about') == 'example.com'
    assert website_domain('https://example.com@evil.com') == ''
    assert normalize_phone('4255550100 ext 9') == ''


@pytest.mark.parametrize('phone', ['123', '+44 12345678901', '4255550100 OR 1=1'])
def test_invalid_phone(phone):
    with pytest.raises(ValidationError):
        OnboardingLookup(work_email='owner@example.com', phone=phone)


def test_strong_match_only_proposes_a_draft():
    result = build_resolution(request(), [('hotel', row())], [])
    assert result['status'] == 'draft_ready'
    assert result['autofill_candidate']['native_identity'] == {'id': '1'}
    assert not result['ownership_verified'] and not result['claim_created']
    assert 'work_email' not in result


def test_shared_identifiers_require_selection():
    result = build_resolution(request(), [('hotel', row()), ('hotel', row())], [])
    assert result['status'] == 'needs_selection'
    assert result['autofill_candidate'] is None


@pytest.mark.parametrize('warnings,truncated', [(['ria unavailable'], False), ([], True)])
def test_incomplete_coverage_blocks_automatic_draft(warnings, truncated):
    assert build_resolution(request(), [('hotel', row())], warnings, truncated)['autofill_candidate'] is None


def test_consumer_domain_never_counts_as_business_evidence():
    result = build_resolution(request('owner@gmail.com'),
        [('hotel', {'id': 1, 'name': 'Example', 'phone': '4255550100', 'website': 'https://gmail.com'})], [])
    assert result['candidates'][0]['match_strength'] == 'possible'


def test_domain_suffix_collision_is_not_a_match():
    result = build_resolution(request(), [('hotel', {'id': 1, 'website': 'https://notexample.com'})], [])
    assert result['status'] == 'no_match'


def test_database_unavailable_is_not_no_match():
    from app.database import DatabaseUnavailable
    def broken():
        raise DatabaseUnavailable('private connection details')
    result = resolve_with_sessions(request(), {'hotel': broken})
    assert result['status'] == 'unavailable'
    assert 'private connection details' not in str(result)


def test_cloud_endpoint_is_no_store_and_validates(monkeypatch):
    import cloud_api.main as cloud
    monkeypatch.setattr(cloud, 'engine_for', lambda vertical: object())
    monkeypatch.setattr(cloud, 'resolve_with_sessions', lambda req, sessions: build_resolution(req, [], []))
    client = TestClient(cloud.app)
    response = client.post('/api/v1/businesses/onboarding/lookup', json={
        'work_email': 'owner@example.com', 'phone': '4255550100'})
    assert response.status_code == 200
    assert response.headers['cache-control'] == 'no-store'
    assert response.json()['scope'] == 'b2b'
    assert client.post('/api/v1/businesses/onboarding/lookup', json={}).status_code == 422
