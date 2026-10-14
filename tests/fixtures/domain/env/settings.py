import os
A = os.environ['PY_A']
B = os.environ.get("PY_B", "x")
C = os.getenv('PY_C')
# D = os.getenv('PY_COMMENTED')
E = os.environ[name]
