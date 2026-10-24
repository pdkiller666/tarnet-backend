#!/usr/bin/env python3
"""mock_train.py — заглушка обучения LoRA для Фазы 2.5.

ЧЕГО ЗДЕСЬ НЕТ: здесь нет обучения. Ни PyTorch, ни GPU, ни градиентов.
Скрипт читает JSONL, считает хеш и возвращает pending_gpu.

ПОЧЕМУ ХЕШ СЧИТАЕТСЯ ПО СОДЕРЖИМОМУ ПЛЮС ДОМЕН, А НЕ ПО ВРЕМЕНИ:
хеш — идентификатор версии адаптера. Если подмешать time.time(), то один
и тот же датасет давал бы новую версию при каждом прогоне, и реестр
adapter_versions заполнялся бы дублями, которые нечем отличить друг от
друга. Содержимое и домен — единственное, что реально определяет набор
весов; сейчас, пока обучения нет, это же и есть вся «версия».
"""
import argparse
import hashlib
import json
import sys


def main():
    parser = argparse.ArgumentParser(description="Mock LoRA trainer (Phase 2.5)")
    parser.add_argument("--file", required=True, help="Path to JSONL dataset")
    parser.add_argument("--domain", required=True, help="Target domain")
    args = parser.parse_args()

    try:
        with open(args.file, "rb") as f:
            data = f.read()
    except OSError as exc:
        print(json.dumps({"status": "error", "error": f"cannot read dataset: {exc}"}))
        return 1

    # Пустой датасет — это не «обучили на нуле пар», а отсутствие работы.
    lines = [ln for ln in data.split(b"\n") if ln.strip()]
    if not lines:
        print(json.dumps({"status": "error", "error": "empty dataset"}))
        return 1

    h = hashlib.sha256()
    h.update(args.domain.encode("utf-8"))
    h.update(b"\x00")
    h.update(data)

    print(json.dumps({
        "status": "pending_gpu",
        "adapterHash": h.hexdigest(),
        "domain": args.domain,
        "datasetFile": args.file,
        "count": len(lines),
        "note": "No training performed. Requires RunPod/Modal GPU (Phase 2.5).",
    }))
    return 0


if __name__ == "__main__":
    sys.exit(main())
