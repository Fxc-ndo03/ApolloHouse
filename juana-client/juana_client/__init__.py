"""Juana Client - Python client for Apollo (Juana) voice assistant."""

__version__ = "0.1.0"

# NO importar .client aqui: cuando se ejecuta `python -m juana_client.client`,
# Python primero importa este paquete (ejecutando __init__.py) y luego runpy
# ejecuta client.py como __main__. Si __init__ ya puso `client` en sys.modules,
# runpy lo detecta como "found in sys.modules after import of package" y emite
# el RuntimeWarning. Los consumidores que usan `import juana_client` obtienen
# los simbolos via los submodulos directamente (from juana_client.client import ...).