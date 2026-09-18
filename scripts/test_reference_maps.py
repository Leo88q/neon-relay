#!/usr/bin/env python3
"""Offline integrity/isolation contracts for optional reference-map trials."""
import hashlib
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from try_reference_maps import catalog, fetch, prepare_storage, server_args, ROOT


class ReferenceMaps(unittest.TestCase):
    def test_catalog_and_dependencies(self):
        rows = catalog()
        self.assertEqual(len(rows), 4)
        for name, row in rows.items():
            self.assertEqual(row['license_status'], 'unverified-do-not-ship')
            self.assertEqual(len(row['revision']), 40)
            self.assertEqual(len(row['sha256']), 64)
            self.assertEqual(row['metadata']['license'], '')
            self.assertEqual(row['external_sounds'], [])
            for image in row['external_images']:
                self.assertTrue((ROOT / 'data/mapres' / (image + '.png')).exists())
            self.assertFalse((ROOT / 'data/maps' / (name + '.map')).exists())

    def test_verified_cache_never_needs_network(self):
        data = b'DATA test fixture'
        row = dict(name='Test', bytes=len(data), sha256=hashlib.sha256(data).hexdigest())
        with tempfile.TemporaryDirectory() as tmp:
            cache = Path(tmp)
            path = cache / 'Test/maps/Test.map'
            path.parent.mkdir(parents=True)
            path.write_bytes(data)
            with patch('urllib.request.urlopen', side_effect=AssertionError('Unexpected network')):
                self.assertEqual(fetch(row, cache), cache / 'Test')
            path.write_bytes(b'bad data')
            with self.assertRaisesRegex(ValueError, 'hash/length mismatch'):
                fetch(row, cache)
            self.assertEqual(path.read_bytes(), b'bad data') # never silently overwrite edits

    def test_server_is_private_and_quoted(self):
        args = server_args(Path('/example/server'), 'Late Evening', 8304)
        self.assertIn('bindaddr 127.0.0.1', args)
        self.assertIn('sv_register 0', args)
        self.assertIn('sv_map "Late Evening"', args)
        self.assertIn('sv_port 8304', args)
        with self.assertRaises(ValueError):
            server_args(Path('/example/server'), 'map";exec unwanted.cfg', 8304)

    def test_storage_has_no_user_config_path(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            prepare_storage(directory)
            storage = (directory / 'storage.cfg').read_text()
            self.assertNotIn('$USERDIR', storage)
            self.assertIn(str(ROOT / 'data'), storage)
            self.assertEqual((directory / 'autoexec_server.cfg').read_text(), '# Isolated local reference-map trial\n')


if __name__ == '__main__':
    unittest.main()
