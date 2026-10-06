import json
import pytest
from app import general_discovery as module, general_business as intake
from app.config import settings


@pytest.fixture
def queue(tmp_path,monkeypatch):
    monkeypatch.setattr(intake,'runtime_state_dir',lambda:str(tmp_path))
    module.initialise()
    area=json.dumps({'zip':'98033','city':'Kirkland','state':'WA','lat':47.68,'lng':-122.20})
    with module.state_db() as db:
        db.execute("INSERT INTO discovery_jobs(zip,category,area,status) VALUES('98033','restaurants',?,'pending')",(area,))
    return ('98033','restaurants',area,0)


def test_stable_identity_distance_and_actual_zip(queue):
    row=dict(name='Cafe',lat=47.68,lng=-122.20,formatted_address='Kirkland WA 98034',raw={'google_cid':'123'})
    record=module.normalise(row,queue)
    assert record.zip=='98034'
    assert record.query_zip=='98033'
    assert record.source_key=='123'
    with pytest.raises(ValueError):
        module.normalise(dict(row,lat=25),queue)
    with pytest.raises(ValueError):
        module.normalise(dict(row,raw={}),queue)


def test_restart_recovers_inflight_jobs(queue):
    module.mark(queue,'collecting',0)
    module.initialise()
    assert module.next_job()[0]=='98033'


def test_acknowledgement_is_durable_with_outbox_and_website_job(queue):
    record=intake.BusinessRecord(source='maps',source_key='123',name='Cafe',category='restaurants',
         source_url='https://www.google.com/maps?cid=123',website='https://example.com')
    module.acknowledge(queue,[record],'done')
    with module.state_db() as db:
        assert db.execute('SELECT status FROM discovery_jobs').fetchone()[0]=='done'
        assert db.execute('SELECT status FROM batches').fetchone()[0]=='pending'
        assert db.execute('SELECT status FROM business_websites').fetchone()[0]=='pending'


def test_daily_budget_persists_across_initialisation(queue,monkeypatch):
    monkeypatch.setattr(settings,'BUSINESS_MAPS_DAILY_CAP',1)
    assert module.reserve_call()
    module.initialise()
    assert not module.reserve_call()


def test_category_validation(monkeypatch):
    monkeypatch.setattr(settings,'BUSINESS_DISCOVERY_CATEGORIES','restaurants,shops,restaurants')
    assert module.categories()==['restaurants','shops']
    monkeypatch.setattr(settings,'BUSINESS_DISCOVERY_CATEGORIES','restaurants;drop database')
    with pytest.raises(ValueError):module.categories()


def test_general_profile_does_not_touch_hotel_profile(tmp_path,monkeypatch):
    from app.chrome_scraper import _BrowserProcess
    hotel=tmp_path/'hotel';general=tmp_path/'general'
    hotel.mkdir();general.mkdir()
    for folder in (hotel,general):(folder/'SingletonLock').write_text('stale')
    browser=_BrowserProcess(str(general))
    monkeypatch.setattr(browser,'_profile_in_use_by_chrome',lambda _:False)
    browser._clear_stale_profile_locks()
    assert not (general/'SingletonLock').exists()
    assert (hotel/'SingletonLock').exists()
