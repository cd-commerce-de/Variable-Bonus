"""
Builds an ASIN -> marketplace ("DE" or "Pan-EU") lookup from Sellerboard's
"Products" export, which carries a Marketplace field the sales export
("Group by Parent") does not. This is what lets Launch Manager's F3M
revenue be split into Germany vs Pan-EU instead of an approximation.

A small number of ASINs (cross-listed catalog entries) show more than one
marketplace across rows in the source file. For those, Germany wins if
present (Germany is the primary market), otherwise the first non-DE
marketplace found is used. This affects roughly 10 of ~3,100 ASINs.

Usage: python3 scripts/build_marketplace_mapping.py <products_export.csv>
Writes: mapping/marketplace_mapping.json
"""
import csv
import json
import argparse
from collections import defaultdict


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('csv_path')
    ap.add_argument('--out', default='mapping/marketplace_mapping.json')
    args = ap.parse_args()

    asin_marketplaces = defaultdict(set)
    with open(args.csv_path, encoding='utf-8-sig') as f:
        reader = csv.DictReader(f, delimiter=';')
        for r in reader:
            asin = r.get('ASIN', '').strip()
            mp = r.get('Marketplace', '').strip()
            if asin and mp:
                asin_marketplaces[asin].add(mp)

    mapping = {}
    ambiguous = []
    for asin, mps in asin_marketplaces.items():
        if 'Amazon.de' in mps:
            mapping[asin] = 'DE'
        else:
            mapping[asin] = 'Pan-EU'
        if len(mps) > 1:
            ambiguous.append({'asin': asin, 'marketplaces_seen': sorted(mps), 'resolved_to': mapping[asin]})

    with open(args.out, 'w', encoding='utf-8') as f:
        json.dump({'mapping': mapping, 'ambiguous_asins': ambiguous}, f, indent=1, ensure_ascii=False)

    print(f'Wrote {args.out}')
    print(f'{len(mapping)} ASINs mapped ({sum(1 for v in mapping.values() if v == "DE")} DE, '
          f'{sum(1 for v in mapping.values() if v == "Pan-EU")} Pan-EU)')
    print(f'{len(ambiguous)} ambiguous ASINs resolved (Germany wins if present):')
    for a in ambiguous:
        print(' ', a)


if __name__ == '__main__':
    main()
