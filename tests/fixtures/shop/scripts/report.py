import csv


def summarize(rows):
    return sum(float(r["total"]) for r in rows)


def main():
    with open("orders.csv") as f:
        print(summarize(csv.DictReader(f)))
