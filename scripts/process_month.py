"""
Process one month's Sellerboard "Group by Parent" export into computed
per-SKU / per-brand / per-track actuals, using the TOC ASIN->stage/brand
mapping.

Usage:
    python3 process_month.py <sellerboard_csv> <YYYY-MM> [--mapping mapping/toc_mapping.json]

Writes: data/<YYYY-MM>.json
"""
import csv
import json
import sys
import argparse
from collections import defaultdict

NUMERIC_COLS = [
    'Units', 'Refunds', 'Sales', 'Promo', 'Ads', 'Sponsored products (PPC)',
    'Sponsored Display', 'Sponsored brands (HSA)', 'Sponsored Brands Video',
    'Google ads', 'Facebook ads', '% Refunds', 'Sellable Quota',
    'Refund сost', 'Amazon fees', 'Cost of Goods', 'VAT', 'Shipping',
    'Gross profit', 'Net profit', 'Estimated payout', 'Expenses', 'Margin',
    'ROI', 'BSR', 'Real ACOS', 'Sessions', 'Unit Session Percentage',
    'Average Sales Price',
]

# Bonus-track routing, per business rule:
#   R&D            -> stage "M4-12" (Y1 products), pooled across all brands
#   Launch Manager -> stage "F3M", split DE vs Pan-EU (needs a marketplace
#                     column this export doesn't have yet -- computed as one
#                     combined pool for now, flagged as pending)
#   Brand Manager  -> stages "PY1", "M4-12" (Y1), "Discontinued", per brand
#   Marketplace    -> manual entry, not derived from this file
# "Quality Issue" stage isn't covered by any track in the current rules;
# it's reported separately so nothing silently disappears.
STAGE_LABELS = {
    'PY1': 'PY1',
    'M4-12': 'Y1 (F4-12)',
    'Discontinued': 'Discontinued',
    'F3M': 'F3M',
    'Quality Issue': 'Quality Issue (unassigned)',
}


def clean_number(x):
    if x is None:
        return 0.0
    x = x.strip().replace('\xa0', '').replace(' ', '')
    if x in ('', '-'):
        return 0.0
    x = x.replace('.', '').replace(',', '.') if x.count(',') == 1 and x.count('.') <= 1 and ',' in x else x.replace(',', '')
    try:
        return float(x)
    except ValueError:
        return 0.0


def load_mapping(path):
    with open(path, encoding='utf-8') as f:
        return json.load(f)


def process(csv_path, mapping):
    with open(csv_path, encoding='utf-8-sig') as f:
        reader = csv.DictReader(f, delimiter=';')
        rows = [r for r in reader if r.get('SKU', '').strip() != '']  # drop parent rollup rows

    unmapped = []
    by_asin = []
    for r in rows:
        asin = r['ASIN'].strip()
        info = mapping.get(asin)
        rec = {
            'asin': asin,
            'sku': r['SKU'].strip(),
            'product': r['Product'],
            'units': clean_number(r.get('Units')),
            'sales': clean_number(r.get('Sales')),
            'net_profit': clean_number(r.get('Net profit')),
            'margin_pct': clean_number(r.get('Margin')),
            'refunds': clean_number(r.get('Refunds')),
        }
        if info is None:
            unmapped.append(rec)
            continue
        rec['brand'] = info['brand']
        rec['stage'] = info['stage']
        rec['status'] = info['status']
        by_asin.append(rec)

    # ---- Aggregations ----
    stage_totals = defaultdict(lambda: {'sales': 0.0, 'units': 0, 'net_profit': 0.0, 'sku_count': 0})
    brand_stage = defaultdict(lambda: {'sales': 0.0, 'units': 0, 'net_profit': 0.0, 'sku_count': 0})

    for rec in by_asin:
        st = stage_totals[rec['stage']]
        st['sales'] += rec['sales']; st['units'] += rec['units']
        st['net_profit'] += rec['net_profit']; st['sku_count'] += 1

        bs = brand_stage[(rec['brand'], rec['stage'])]
        bs['sales'] += rec['sales']; bs['units'] += rec['units']
        bs['net_profit'] += rec['net_profit']; bs['sku_count'] += 1

    # R&D: pooled Y1 (M4-12) actuals, across all brands
    rd_pool = stage_totals.get('M4-12', {'sales': 0, 'units': 0, 'net_profit': 0, 'sku_count': 0})

    # Launch Manager: F3M actuals -- combined only, DE/Pan-EU split pending
    launch_pool = stage_totals.get('F3M', {'sales': 0, 'units': 0, 'net_profit': 0, 'sku_count': 0})

    # Brand Manager: per-brand PY1 + Y1(M4-12) + Discontinued
    brands = sorted(set(rec['brand'] for rec in by_asin))
    brand_manager = {}
    for b in brands:
        stages = {}
        combined = {'sales': 0.0, 'units': 0, 'net_profit': 0.0, 'sku_count': 0}
        for stage_key in ('PY1', 'M4-12', 'Discontinued'):
            d = brand_stage.get((b, stage_key), {'sales': 0.0, 'units': 0, 'net_profit': 0.0, 'sku_count': 0})
            stages[STAGE_LABELS[stage_key]] = d
            combined['sales'] += d['sales']; combined['units'] += d['units']
            combined['net_profit'] += d['net_profit']; combined['sku_count'] += d['sku_count']
        brand_manager[b] = {'stages': stages, 'combined': combined}

    quality_issue = stage_totals.get('Quality Issue', {'sales': 0, 'units': 0, 'net_profit': 0, 'sku_count': 0})

    result = {
        'rd_team': {
            'label': 'R&D Team \u2014 Y1 products (pooled)',
            'actual': rd_pool,
            'target': None,
            'tier': 'AWAITING TARGET',
            'bonus_eur': None,
        },
        'launch_manager': {
            'label': 'Launch Manager \u2014 F3M (DE / Pan-EU split pending: source file has no marketplace column)',
            'actual_combined': launch_pool,
            'actual_de': None,
            'actual_pan_eu': None,
            'target': None,
            'tier': 'AWAITING TARGET + MARKETPLACE SPLIT',
            'bonus_eur': None,
        },
        'brand_manager': {
            b: {
                'stages': v['stages'],
                'combined_actual': v['combined'],
                'target': None,
                'tier': 'AWAITING TARGET',
                'bonus_eur': None,
            } for b, v in brand_manager.items()
        },
        'marketplace': {
            'label': 'Marketplace \u2014 manually entered',
            'actual': None,
            'target': None,
            'tier': None,
            'bonus_eur': None,
        },
        'quality_issue_unassigned': quality_issue,
        'meta': {
            'total_rows_processed': len(rows),
            'mapped_rows': len(by_asin),
            'unmapped_rows': len(unmapped),
            'unmapped_asins': sorted(set(u['asin'] for u in unmapped))[:200],
        },
    }
    return result


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('csv_path')
    ap.add_argument('month')  # YYYY-MM
    ap.add_argument('--mapping', default='mapping/toc_mapping.json')
    ap.add_argument('--out-dir', default='data')
    args = ap.parse_args()

    mapping = load_mapping(args.mapping)
    result = process(args.csv_path, mapping)
    result['month'] = args.month

    out_path = f'{args.out_dir}/{args.month}.json'
    with open(out_path, 'w', encoding='utf-8') as f:
        json.dump(result, f, ensure_ascii=False, indent=1)

    print('Wrote', out_path)
    print('Rows processed:', result['meta']['total_rows_processed'],
          '| mapped:', result['meta']['mapped_rows'],
          '| unmapped:', result['meta']['unmapped_rows'])
    print('R&D pool sales: EUR {:,.2f}'.format(result['rd_team']['actual']['sales']))
    print('Launch Mgr (F3M combined) sales: EUR {:,.2f}'.format(result['launch_manager']['actual_combined']['sales']))
    for b, v in result['brand_manager'].items():
        print(f"  BM {b}: EUR {v['combined_actual']['sales']:,.2f}")


if __name__ == '__main__':
    main()
