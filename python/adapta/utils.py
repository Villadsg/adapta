from event_dataset import build_ticker_features


def build_result(ticker: str, prob: float, event_threshold: float, meta: dict,
                 target: str = "event") -> dict:
    result = {
        "ticker": ticker,
        "forecast_date": meta["forecast_date"],
        "event_probability": round(prob, 4),
        "event_threshold": round(event_threshold, 2),
        "predicted_event_magnitude": round(prob * event_threshold, 2),
        "context_start": meta["context_start"],
        "context_end": meta["context_end"],
        "context_days": meta["context_days"],
    }
    if target == "direction":
        result["up_probability"] = result.pop("event_probability")
        result["down_probability"] = round(1 - prob, 4)
        del result["predicted_event_magnitude"]
        del result["event_threshold"]
    return result
