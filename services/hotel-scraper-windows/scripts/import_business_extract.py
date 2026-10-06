"""Stream a trusted .osm XML extract into durable 200-record intake batches.

No download, Cloud SQL call, giant in-memory dataset, or paid API. Nodes only;
way/relation geometries require a subsequent geometry-aware importer.
"""
import argparse
import xml.etree.ElementTree as ET
from app.general_business import BusinessRecord, BusinessBatch, enqueue

AMENITIES={'restaurant','cafe','fast_food','bar','pub','bank','pharmacy','fuel','car_rental',
           'car_wash','cinema','dentist','clinic','veterinary','gym'}


def map_node(element):
    tags={tag.attrib['k']:tag.attrib['v'] for tag in element.findall('tag')}
    category=None
    for key in ('shop','office','craft'):
        if tags.get(key) and tags[key] not in ('no','vacant'):
            category=f'{key}:{tags[key]}'
            break
    if not category and tags.get('amenity') in AMENITIES:
        category=tags['amenity']
    if not category or not tags.get('name','').strip():
        return None
    key=element.attrib['id']
    zipcode=tags.get('addr:postcode','').split('-')[0]
    state=tags.get('addr:state')
    return BusinessRecord(source='osm',source_key='node/'+key,name=tags['name'],category=category,
        source_url='https://www.openstreetmap.org/node/'+key,
        lat=float(element.attrib['lat']),lng=float(element.attrib['lon']),
        formatted_address=' '.join(tags.get(k,'') for k in ('addr:housenumber','addr:street','addr:city')).strip() or None,
        zip=zipcode if len(zipcode)==5 and zipcode.isdigit() else None,
        state=state if state and len(state)==2 and state.isupper() else None,
        phone=tags.get('phone') or tags.get('contact:phone'),
        website=tags.get('website') or tags.get('contact:website'))


def import_extract(path):
    batch=[]; queued=0; skipped=0
    context=ET.iterparse(path,events=('start','end'))
    _,root=next(context)
    for event,element in context:
        if event!='end' or element.tag not in ('node','way','relation'):
            continue
        record=None
        if element.tag=='node':
            try:
                record=map_node(element)
            except (ValueError,KeyError):
                skipped+=1
        if record:
            batch.append(record)
        if len(batch)>=200:
            enqueue(BusinessBatch(records=batch));queued+=len(batch);batch=[]
            print(f'Durably queued: {queued}; invalid records skipped: {skipped}',flush=True)
        # Clear completed top-level elements only, not tags before node mapping.
        root.clear()
    if batch:
        enqueue(BusinessBatch(records=batch));queued+=len(batch)
    return {'queued':queued,'invalid_skipped':skipped,'geometry_scope':'nodes only'}


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('extract',help='Trusted local .osm XML file (not PBF)')
    print(import_extract(parser.parse_args().extract))
