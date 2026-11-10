import os
from datetime import date, datetime, timezone, timedelta
from typing import Annotated
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, ConfigDict, Field, StrictInt, model_validator
from core import Predictor

class Day(BaseModel):
    model_config = ConfigDict(extra='forbid')
    date: Annotated[str, Field(pattern=r'^\d{4}-\d{2}-\d{2}$')]
    requestedUnits: Annotated[StrictInt, Field(ge=0, le=1000000000)]

class Request(BaseModel):
    model_config = ConfigDict(extra='forbid')
    warehouseId: Annotated[str, Field(pattern=r'^[a-fA-F0-9]{24}$')]
    productId: Annotated[str, Field(pattern=r'^[a-fA-F0-9]{24}$')]
    horizonDays: Annotated[StrictInt, Field(ge=1, le=7)]
    history: Annotated[list[Day], Field(min_length=28, max_length=730)]

    @model_validator(mode='after')
    def consecutive(self):
        dates = [date.fromisoformat(day.date) for day in self.history]
        if any(b - a != timedelta(days=1) for a, b in zip(dates, dates[1:])):
            raise ValueError('History must be consecutive and ordered')
        if dates[-1] >= datetime.now(timezone.utc).date():
            raise ValueError('History must exclude today and future dates')
        return self

app = FastAPI(title='WarehouseOS forecast service', version='1.0.0')
predictor = Predictor(os.environ.get('MODEL_DIR', '/models'))

@app.get('/health')
def health():
    return {'ready': True, 'artifactLoaded': predictor.meta is not None, 'fallbackReason': predictor.reason}

@app.post('/v1/forecasts')
def forecast(request: Request):
    try:
        result = predictor.predict([d.requestedUnits for d in request.history], date.fromisoformat(request.history[-1].date) + timedelta(days=1), request.horizonDays)
    except ValueError as error:
        raise HTTPException(503, 'Inference unavailable') from error
    return {'productId': request.productId, 'inputThroughDate': request.history[-1].date, **result}
