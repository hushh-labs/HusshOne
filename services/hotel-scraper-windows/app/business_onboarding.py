"""Read-only B2B candidate resolution; never verifies a claimant or changes ownership."""
import asyncio
import re
from urllib.parse import urlsplit

from fastapi import APIRouter, HTTPException, Response
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import MetaData, Table, func, or_, select
from sqlalchemy.orm import Session
from sqlalchemy.exc import SQLAlchemyError
from app.database import DatabaseUnavailable

router = APIRouter(prefix='/api/v1/businesses', tags=['B2B onboarding'])
TABLES = {'hotel': ('hotels', 'id', 'name'),
          'healthcare': ('providers', 'npi', 'organization_name'),
          'ria': ('firms', 'crd', 'firm_name'),
          'insurance': ('producers', 'id', 'full_name'),
          'business': ('businesses', 'id', 'name')}
CONSUMER_DOMAINS = {'gmail.com', 'googlemail.com', 'yahoo.com', 'outlook.com',
                    'hotmail.com', 'live.com', 'icloud.com', 'aol.com',
                    'proton.me', 'protonmail.com', 'yahoo.co.in', 'mail.com'}


def normalize_phone(value):
    value = str(value or '').strip()
    if not re.fullmatch(r'[+\d\s().-]+', value):
        return ''
    digits = re.sub(r'\D', '', value)
    if len(digits) == 11 and digits.startswith('1'):
        digits = digits[1:]
    # Current directory datasets are US; do not guess international country codes.
    return digits if len(digits) == 10 else ''


def website_domain(value):
    try:
        parsed = urlsplit(value if '://' in value else 'https://' + value)
        if parsed.scheme not in {'https', 'http'} or parsed.username or parsed.password:
            return ''
        return (parsed.hostname or '').lower().removeprefix('www.').rstrip('.')
    except (ValueError, TypeError):
        return ''


class OnboardingLookup(BaseModel):
    work_email: str = Field(min_length=3, max_length=254)
    phone: str = Field(min_length=7, max_length=40)

    @field_validator('work_email')
    @classmethod
    def email(cls, value):
        value = value.strip().lower()
        if not re.fullmatch(r'[^\s@]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}', value):
            raise ValueError('Provide a valid work email')
        if '..' in value.split('@')[1]:
            raise ValueError('Invalid email domain')
        return value

    @field_validator('phone')
    @classmethod
    def phone_number(cls, value):
        normalized = normalize_phone(value)
        if not normalized:
            raise ValueError('Provide a US ten-digit phone number, optionally with +1')
        return normalized


def candidate_rows(db, vertical, request):
    table_name, key, name = TABLES[vertical]
    table = Table(table_name, MetaData(), schema='public', autoload_with=db.connection())
    domain = request.work_email.split('@')[1]
    predicates = []
    if 'phone' in table.c:
        digits = func.regexp_replace(table.c.phone, '[^0-9]', '', 'g')
        predicates.append(digits.in_([request.phone, '1' + request.phone]))
    if 'website' in table.c and domain not in CONSUMER_DOMAINS:
        host = func.split_part(func.regexp_replace(func.lower(table.c.website), '^https?://', ''), '/', 1)
        predicates.append(host.in_([domain, 'www.' + domain]))
    if not predicates:
        return []
    allowed = {key, name, 'phone', 'website', 'formatted_address', 'address_line1',
               'street1', 'city', 'zip', 'state', 'category', 'last_seen',
               'source', 'source_key', 'source_state', 'license_no'}
    query = select(*(table.c[c] for c in sorted(allowed & set(table.c.keys())))).where(or_(*predicates))
    if vertical == 'healthcare':
        query = query.where(table.c.entity_type.in_(['organization', '2']))
    if vertical == 'insurance':
        query = query.where(table.c.entity_type == 'agency')
    return [dict(row) for row in db.execute(query.order_by(table.c[key]).limit(21)).mappings()]


def build_resolution(request, rows, warnings, truncated=False):
    domain = request.work_email.split('@')[1]
    candidates = []
    for vertical, row in rows:
        table, key, name = TABLES[vertical]
        phone_match = normalize_phone(row.get('phone')) == request.phone
        domain_match = domain not in CONSUMER_DOMAINS and website_domain(row.get('website') or '') == domain
        if not phone_match and not domain_match:
            continue
        identity = {key: str(row[key])}
        if vertical == 'insurance':
            identity = {k: row[k] for k in ('source_state', 'license_no')}
        if vertical == 'business':
            identity = {k: row[k] for k in ('source', 'source_key')}
        candidates.append({'vertical': vertical, 'canonical_table': table,
            'native_identity': identity, 'name': row.get(name),
            'match_strength': 'strong' if phone_match and domain_match else 'possible',
            'evidence': {'exact_phone_match': phone_match, 'exact_website_domain_match': domain_match},
            'draft': {k: row[k] for k in ('phone', 'website', 'formatted_address', 'address_line1',
                       'street1', 'city', 'zip', 'state', 'category') if row.get(k)},
            'last_seen': row.get('last_seen'), 'ownership_verified': False})
    candidates.sort(key=lambda row: row['match_strength'] != 'strong')
    # Multiple records, including branches sharing phones/domains, always need selection.
    unique = len(candidates) == 1 and candidates[0]['match_strength'] == 'strong' and not warnings and not truncated
    return {'contract_version': 'b2b-onboarding.v1', 'scope': 'b2b',
            'status': 'draft_ready' if unique else 'needs_selection' if candidates else 'unavailable' if warnings else 'no_match',
            'candidates': candidates, 'autofill_candidate': candidates[0] if unique else None,
            'warnings': warnings, 'truncated': truncated,
            'ownership_verified': False, 'claim_created': False,
            'verification_required': ['email_control', 'phone_control', 'business_authority'],
            'notice': 'A directory match is not proof of authority. Confirm fields before saving; this endpoint performs no writes.'}


def resolve_with_sessions(request, sessions):
    rows, warnings, truncated = [], [], False
    for vertical, factory in sessions.items():
        try:
            with factory() as db:
                found = candidate_rows(db, vertical, request)
                truncated |= len(found) > 20
                rows.extend((vertical, row) for row in found[:20])
        except (SQLAlchemyError, DatabaseUnavailable, KeyError):
            warnings.append(f'{vertical} unavailable; matching coverage is incomplete')
    return build_resolution(request, rows, warnings, truncated)


@router.post('/onboarding/lookup')
async def local_lookup(request: OnboardingLookup, response: Response):
    from app import database
    from app.directory_fleet import registry_session
    response.headers['Cache-Control'] = 'no-store'
    factories = {'hotel': database.get_readonly_db_session}
    factories.update({v: (lambda vertical=v: registry_session(vertical)) for v in TABLES if v != 'hotel'})
    try:
        return await asyncio.to_thread(resolve_with_sessions, request, factories)
    except database.DatabaseUnavailable:
        raise HTTPException(503, 'Directory connection unavailable') from None
