import pytest
from pydantic import ValidationError
from app import general_business as module


def record(**overrides):
    return module.BusinessRecord(**dict(source='osm',source_key='node/1',name='Restaurant',
        category='restaurant',source_url='https://www.openstreetmap.org/node/1',**overrides))


def test_validation_rejects_bad_identity_and_partial_coordinates():
    with pytest.raises(ValidationError):
        module.BusinessRecord(source='osm',source_key='1',name=' ',category='shop',source_url='https://example.com')
    with pytest.raises(ValidationError):
        record(lat=20)


def test_durable_queue_survives_reopen(tmp_path,monkeypatch):
    monkeypatch.setattr(module,'runtime_state_dir',lambda:str(tmp_path))
    run_id=module.enqueue(module.BusinessBatch(records=[record()]))
    with module.queue_db() as db:
        row=db.execute('SELECT id,status,payload FROM batches').fetchone()
    assert row[:2]==(run_id,'pending')
    assert module.BusinessBatch.model_validate_json(row[2]).records[0].category=='restaurant'
    assert module.general_worker.status()['progress']['pending_batches']==1


def test_batch_is_bounded():
    with pytest.raises(ValidationError):
        module.BusinessBatch(records=[record()]*201)


def test_existing_values_and_native_directories_are_not_overwritten():
    assert 'COALESCE(businesses.zip,EXCLUDED.zip)' in module.UPSERT
    assert 'name=EXCLUDED.name' not in module.UPSERT
    assert 'INSERT INTO public.businesses' in module.UPSERT
    for forbidden in ('DELETE','TRUNCATE','hotels','providers','advisers','producers'):
        assert forbidden not in module.UPSERT


def test_osm_restaurant_shop_and_showroom_mapping():
    import xml.etree.ElementTree as ET
    from scripts.import_business_extract import map_node
    for tag,value,category in [('amenity','restaurant','restaurant'),('shop','car','shop:car'),('shop','clothes','shop:clothes')]:
        element=ET.fromstring(f'<node id="1" lat="47" lon="-122"><tag k="name" v="Example"/><tag k="{tag}" v="{value}"/></node>')
        assert map_node(element).category==category
    assert map_node(ET.fromstring('<node id="2" lat="47" lon="-122"><tag k="name" v="Public bench"/><tag k="amenity" v="bench"/></node>')) is None


def test_extract_streaming_queues_nodes_and_reports_scope(tmp_path,monkeypatch):
    from scripts import import_business_extract as importer
    path=tmp_path/'sample.osm'
    path.write_text('<osm><node id="1" lat="47" lon="-122"><tag k="name" v="Example"/><tag k="shop" v="car"/></node></osm>')
    batches=[]
    monkeypatch.setattr(importer,'enqueue',batches.append)
    result=importer.import_extract(path)
    assert result['queued']==1
    assert batches[0].records[0].category=='shop:car'
