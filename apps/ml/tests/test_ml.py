import tempfile
import unittest
from datetime import date, timedelta
import numpy as np
from fastapi.testclient import TestClient
from app import app
from core import Predictor, features, metrics
from train import generate, samples, train

class MLTests(unittest.TestCase):
    def request(self):
        end = date.today() - timedelta(days=1)
        return {'warehouseId': 'a' * 24, 'productId': 'b' * 24, 'horizonDays': 7,
                'history': [{'date': (end - timedelta(days=27-i)).isoformat(), 'requestedUnits': i % 9} for i in range(28)]}

    def test_input_and_dates(self):
        client = TestClient(app)
        request = self.request()
        response = client.post('/v1/forecasts', json=request)
        self.assertEqual(response.status_code, 200)
        result = response.json()
        self.assertEqual(len(result['predictions']), 7)
        self.assertEqual(result['predictions'][0]['date'], date.today().isoformat())
        for change in ['short', 'gap', 'negative', 'boolean', 'future', 'horizon', 'invalid_date']:
            request = self.request()
            if change == 'short': request['history'].pop()
            if change == 'gap': request['history'][1]['date'] = request['history'][0]['date']
            if change == 'negative': request['history'][0]['requestedUnits'] = -1
            if change == 'boolean': request['history'][0]['requestedUnits'] = True
            if change == 'future': request['history'][-1]['date'] = date.today().isoformat()
            if change == 'horizon': request['horizonDays'] = 8
            if change == 'invalid_date': request['history'][0]['date'] = '2026-02-30'
            self.assertEqual(client.post('/v1/forecasts', json=request).status_code, 422, change)

    def test_missing_artifact_baseline_and_zero_metric(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Predictor(directory).predict([0] * 28, date.today(), 7)
            self.assertEqual(output['method'], 'baseline')
            self.assertTrue(all(p['predictedUnits'] == 0 for p in output['predictions']))
        self.assertIsNone(metrics([0, 0], [1, 1])['wape'])

    def test_past_only_and_chronological_targets(self):
        data = generate(products=2)
        groups, train_end, val_end = samples(data)
        self.assertTrue(all(s[4] + 7 <= train_end for s in groups['train']))
        self.assertTrue(all(s[4] >= train_end and s[4] + 7 <= val_end for s in groups['validation']))
        self.assertTrue(all(s[4] >= val_end for s in groups['test']))
        history = list(range(28))
        np.testing.assert_array_equal(features(history, date(2024, 2, 1)), features(history + [], date(2024, 2, 1)))
        self.assertEqual(features(history, date(2024, 2, 1))[0], 27)
        self.assertEqual(features(history, date(2024, 2, 1))[1], 21)
        # Future changes leave the first training feature vector untouched.
        modified = generate(products=2)
        modified['series'][0]['values'][100:] = [9999] * (365-100)
        other, _, _ = samples(modified)
        np.testing.assert_array_equal(groups['train'][0][0], other['train'][0][0])

    def test_reproducible_training_and_artifact_roundtrip(self):
        with tempfile.TemporaryDirectory() as a, tempfile.TemporaryDirectory() as b:
            first, second = train(a, epochs=2), train(b, epochs=2)
            self.assertEqual(first, second)
            selected = min(first['evaluation']['validation'], key=lambda k: first['evaluation']['validation'][k]['mae'])
            self.assertEqual(first['selectedMethod'], selected)
            self.assertIsNotNone(Predictor(a).meta)

if __name__ == '__main__':
    unittest.main()
