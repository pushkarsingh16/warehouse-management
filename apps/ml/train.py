"""Reproducible synthetic benchmark; validation selects method, test only reports it."""
import argparse
import hashlib
import json
from datetime import date, timedelta
from pathlib import Path
import numpy as np
import torch
from core import DemandMLP, FEATURES, SCHEMA, baseline, features, metrics


def generate(seed=42, products=60, days=365):
    rng = np.random.default_rng(seed)
    start = date(2024, 1, 1)
    rows = []
    for product in range(products):
        level = rng.uniform(2, 35)
        values = []
        kind = product % 5
        for day in range(days):
            weekly = 1 + .35 * np.sin(2 * np.pi * (start + timedelta(days=day)).weekday() / 7)
            trend = 1 + (.7 * day / days if kind == 1 else 0)
            rate = level * weekly * trend
            if kind == 2 and rng.random() < .7:
                units = 0
            else:
                units = int(rng.poisson(rate))
            if kind == 3 and rng.random() < .03:
                units *= 4
            if kind == 4:
                units = 0
            values.append(units)
        rows.append({'product': product, 'kind': kind, 'values': values})
    return {'synthetic': True, 'generatorVersion': 'scenario-v1', 'seed': seed, 'startDate': start.isoformat(), 'days': days, 'series': rows}


def samples(dataset):
    start = date.fromisoformat(dataset['startDate'])
    train_end, validation_end = int(dataset['days'] * .6), int(dataset['days'] * .8)
    groups = {name: [] for name in ['train', 'validation', 'test']}
    for series in dataset['series']:
        v = series['values']
        for origin in range(28, len(v) - 6):
            # A sample's entire target window must lie within its split.
            split = 'train' if origin + 7 <= train_end else 'validation' if origin >= train_end and origin + 7 <= validation_end else 'test' if origin >= validation_end else None
            if split:
                groups[split].append((features(v[:origin], start + timedelta(days=origin)), v[origin:origin + 7], baseline(v[:origin], 'moving_average'), baseline(v[:origin], 'same_weekday'), origin))
    return groups, train_end, validation_end


def train(output, epochs=100, seed=42):
    torch.manual_seed(seed)
    torch.use_deterministic_algorithms(True)
    dataset = generate(seed)
    encoded = json.dumps(dataset, sort_keys=True).encode()
    digest = hashlib.sha256(encoded).hexdigest()
    groups, train_end, val_end = samples(dataset)
    arrays = {k: [np.asarray([row[i] for row in rows], dtype=np.float32) for i in range(4)] for k, rows in groups.items()}
    mean, std = arrays['train'][0].mean(0), arrays['train'][0].std(0).clip(.0001)
    model = DemandMLP()
    optimizer = torch.optim.Adam(model.parameters(), lr=.005)
    x = torch.from_numpy((arrays['train'][0] - mean) / std)
    y = torch.from_numpy(arrays['train'][1])
    for _ in range(epochs):
        model.train()
        optimizer.zero_grad()
        loss = torch.nn.functional.l1_loss(model(x), y)
        loss.backward()
        optimizer.step()
    model.eval()
    evaluation = {}
    for name in ['validation', 'test']:
        values = arrays[name]
        with torch.inference_mode():
            predicted = model(torch.from_numpy((values[0] - mean) / std)).numpy()
        evaluation[name] = {method: metrics(values[1], pred) for method, pred in [('pytorch', predicted), ('moving_average', values[2]), ('same_weekday', values[3])]}
    selected = min(evaluation['validation'], key=lambda method: evaluation['validation'][method]['mae'])
    version = f'demand-v1-{digest[:12]}-e{epochs}'
    root = Path(output)
    folder = root / version
    folder.mkdir(parents=True, exist_ok=True)
    meta = {'modelVersion': version, 'featureSchema': SCHEMA, 'features': FEATURES, 'horizonDays': 7,
            'mean': mean.tolist(), 'std': std.tolist(), 'selectedMethod': selected, 'selectionMetric': 'validation.mae',
            'trainingCutoff': (date.fromisoformat(dataset['startDate']) + timedelta(days=train_end - 1)).isoformat(),
            'validationCutoff': (date.fromisoformat(dataset['startDate']) + timedelta(days=val_end - 1)).isoformat(),
            'datasetSha256': digest, 'synthetic': True, 'seed': seed, 'epochs': epochs, 'evaluation': evaluation,
            'limitation': 'Synthetic benchmark only; no real-world accuracy claim.'}
    torch.save(model.state_dict(), folder / 'weights.pt')
    (folder / 'dataset.json').write_bytes(encoded)
    (folder / 'metadata.json').write_text(json.dumps(meta, indent=2, allow_nan=False))
    (root / 'CURRENT.tmp').write_text(version)
    (root / 'CURRENT.tmp').replace(root / 'CURRENT')
    print(json.dumps(meta, indent=2))
    return meta

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', default='/models')
    parser.add_argument('--epochs', type=int, default=100)
    parser.add_argument('--seed', type=int, default=42)
    args = parser.parse_args()
    if not 1 <= args.epochs <= 10000:
        parser.error('epochs must be 1–10000')
    train(args.output, args.epochs, args.seed)
