"""Shared, past-only features and CPU inference. Artifacts must be trusted local files."""
import json
import math
import pickle
from datetime import date, timedelta
from pathlib import Path
import numpy as np
import torch
from torch import nn

FEATURES = ['lag1', 'lag7', 'lag14', 'mean7', 'mean14', 'std14', 'weekday_sin', 'weekday_cos']
SCHEMA = 'past-demand-v1'
torch.set_num_threads(1)


def features(history, start):
    values = np.asarray(history, dtype=np.float32)
    weekday = start.weekday()
    return np.array([values[-1], values[-7], values[-14], values[-7:].mean(),
                     values[-14:].mean(), values[-14:].std(),
                     math.sin(2 * math.pi * weekday / 7), math.cos(2 * math.pi * weekday / 7)], dtype=np.float32)


def baseline(history, method, horizon=7):
    if method == 'same_weekday':
        return np.asarray(history[-7:], dtype=float)[:horizon]
    return np.full(horizon, np.mean(history[-7:]), dtype=float)


class DemandMLP(nn.Module):
    def __init__(self):
        super().__init__()
        self.network = nn.Sequential(nn.Linear(len(FEATURES), 64), nn.ReLU(), nn.Linear(64, 32), nn.ReLU(), nn.Linear(32, 7), nn.Softplus())

    def forward(self, x):
        return self.network(x)


def metrics(actual, predicted):
    actual, predicted = np.asarray(actual), np.asarray(predicted)
    error = np.abs(actual - predicted)
    total = float(np.abs(actual).sum())
    return {'mae': float(error.mean()), 'wape': float(error.sum() / total) if total else None,
            'zeroActualTotal': total == 0}


class Predictor:
    def __init__(self, directory):
        self.model = None
        self.meta = None
        self.reason = 'MODEL_MISSING'
        try:
            root = Path(directory)
            version = (root / 'CURRENT').read_text().strip()
            if not version or Path(version).name != version:
                raise ValueError('Invalid artifact pointer')
            folder = root / version
            meta = json.loads((folder / 'metadata.json').read_text())
            if meta['featureSchema'] != SCHEMA or meta['features'] != FEATURES or meta['horizonDays'] != 7:
                raise ValueError('Incompatible feature contract')
            self.mean = np.asarray(meta['mean'], dtype=np.float32)
            self.std = np.asarray(meta['std'], dtype=np.float32)
            if self.mean.shape != (8,) or self.std.shape != (8,) or not np.isfinite(self.mean).all() or not np.isfinite(self.std).all() or (self.std <= 0).any():
                raise ValueError('Invalid preprocessing')
            if meta['selectedMethod'] not in ['pytorch', 'moving_average', 'same_weekday']:
                raise ValueError('Invalid selected method')
            model = DemandMLP()
            model.load_state_dict(torch.load(folder / 'weights.pt', map_location='cpu', weights_only=True))
            model.eval()
            self.model, self.meta, self.reason = model, meta, None
        except (OSError, ValueError, KeyError, RuntimeError, EOFError, pickle.UnpicklingError, TypeError, IndexError):
            self.reason = 'MODEL_MISSING_OR_INCOMPATIBLE'

    def predict(self, history, start, horizon):
        selected = self.meta['selectedMethod'] if self.meta else 'moving_average'
        if selected == 'pytorch':
            x = (features(history, start) - self.mean) / self.std
            with torch.inference_mode():
                values = self.model(torch.from_numpy(x)).numpy()[:horizon]
        else:
            values = baseline(history, selected, horizon)
        if not np.isfinite(values).all() or (values < 0).any():
            raise ValueError('Invalid predictions')
        return {'modelVersion': self.meta['modelVersion'] if self.meta else 'baseline-moving-average-v1',
                'method': 'pytorch' if selected == 'pytorch' else 'baseline', 'baselineMethod': None if selected == 'pytorch' else selected,
                'fallbackReason': self.reason,
                'predictions': [{'date': (start + timedelta(days=i)).isoformat(), 'predictedUnits': float(v)} for i, v in enumerate(values)]}
