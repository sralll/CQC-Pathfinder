import json
import math
import os
import tempfile
from datetime import timedelta
from unittest import mock

from django.contrib.auth.models import Group, User
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import SimpleTestCase, TestCase, override_settings
from django.urls import reverse
from django.utils import timezone

from account.models import Profile, Team
from project import UNet
from project import views as project_views
from project.models import ControlPair, File, FileSnapshot, Route
from project.services.passage_validation import (
    MAX_LEVEL_PASSAGES_BYTES,
    MAX_PASSAGES,
    MAX_POINTS_PER_PASSAGE,
    LevelPassagesValidationError,
    empty_level_passages,
    normalize_level_passages,
)


PASSAGE_ID_1 = '8cb8a384-c073-4a4d-9dce-b67e2c6de101'
PASSAGE_ID_2 = '7b03b060-a710-4874-932f-cf4a2b425313'


class MaskDilationTests(SimpleTestCase):
    def test_impassable_outline_only_darkens_neighbouring_pixels(self):
        import numpy as np

        mask = np.array([
            [255, 231, 241],
            [135,   0, 200],
            [199, 243, 255],
        ], dtype=np.uint8)

        result = UNet._add_impassable_outline(mask)

        np.testing.assert_array_equal(result, np.array([
            [200, 200, 200],
            [135,   0, 200],
            [199, 200, 200],
        ], dtype=np.uint8))

    def test_editor_uses_same_outline_greyscale(self):
        editor_js = os.path.join(
            os.path.dirname(UNet.__file__), 'static', 'project', 'js', 'editor.js')

        with open(editor_js, encoding='utf-8') as source:
            self.assertIn(
                f'const MASK_EXPANSION = {UNet.MASK_OUTLINE};', source.read())


class PassageConnectorGridTests(SimpleTestCase):
    def test_connector_error_uses_sidebar_number_not_uuid(self):
        from project.navgraph import PassageConnectorError

        error = PassageConnectorError(PASSAGE_ID_1, 'start', passage_number=2)

        self.assertEqual(
            str(error),
            'Passage 2 start endpoint has no legal base connector',
        )
        self.assertEqual(error.passage_id, PASSAGE_ID_1)

    def test_connector_uses_pixel_grid_when_direct_line_is_blocked(self):
        import numpy as np
        from project.navgraph import _line_cost, _passage_connector_cost

        mask = np.full((9, 9), 255, dtype=np.uint8)
        mask[:, 4] = 0
        mask[8, 4] = 255
        start, goal = (2, 4), (6, 4)

        self.assertIsNone(_line_cost(mask, *start, *goal))
        result = _passage_connector_cost(mask, start, goal)

        self.assertIsNotNone(result)
        _cost, used_grid_path = result
        self.assertTrue(used_grid_path)

        mask[8, 4] = 0
        self.assertIsNone(_passage_connector_cost(mask, start, goal))

    def test_endpoint_at_region_edge_can_connect_to_inward_base_nodes(self):
        from PIL import Image
        from project.navgraph import build_navgraph

        document = {
            'version': 1,
            'items': [{
                'id': PASSAGE_ID_1,
                'points': [[1, 128], [80, 128]],
                'width': 8,
            }],
        }
        region = [[0, 0], [255, 0], [255, 255], [0, 255]]
        with tempfile.TemporaryDirectory() as directory:
            mask_path = os.path.join(directory, 'edge-passage.png')
            Image.new('L', (256, 256), color=255).save(mask_path)

            artifact = build_navgraph(
                mask_path,
                region_polygon=region,
                level_passages=document,
            )

        self.assertGreaterEqual(artifact['stats']['passage_connector_count'], 2)
        self.assertEqual(artifact['stats']['unusable_endpoints'], [])


def level_passages_document(*, passage_id=PASSAGE_ID_1, width=24, points=None):
    return {
        'version': 1,
        'items': [{
            'id': passage_id,
            'points': points or [[10, 20.5], [30.25, 40]],
            'width': width,
        }],
    }


class AuthenticatedSurfaceTests(TestCase):
    def test_user_pages_redirect_to_login_when_anonymous(self):
        private_urls = [
            reverse('home'),
            reverse('guide'),
            reverse('javascript-catalog'),
        ]

        for url in private_urls:
            with self.subTest(url=url):
                response = self.client.get(url)
                self.assertEqual(response.status_code, 302)
                self.assertIn('/login/', response['Location'])

    def test_login_page_stays_public(self):
        response = self.client.get(reverse('login'))

        self.assertEqual(response.status_code, 200)

class DevAgentLoginTests(SimpleTestCase):
    @override_settings(DEBUG=True)
    def test_next_must_be_a_local_path(self):
        from CQCPathfinder.views import dev_agent_login
        from django.test import RequestFactory

        with mock.patch('account.dev.ensure_agent_user', return_value=User()), \
                mock.patch('CQCPathfinder.views.login'):
            request = RequestFactory().get(
                '/dev/agent-login/', {'next': '//evil.example/login'})
            response = dev_agent_login(request)

        self.assertEqual(response.status_code, 302)
        self.assertEqual(response.url, '/')

    @override_settings(DEBUG=True)
    def test_local_next_path_is_preserved(self):
        from CQCPathfinder.views import dev_agent_login
        from django.test import RequestFactory

        with mock.patch('account.dev.ensure_agent_user', return_value=User()), \
                mock.patch('CQCPathfinder.views.login'):
            request = RequestFactory().get(
                '/dev/agent-login/', {'next': '/editor/'})
            response = dev_agent_login(request)

        self.assertEqual(response.status_code, 302)
        self.assertEqual(response.url, '/editor/')


class EditorPayloadLimitTests(TestCase):
    def setUp(self):
        self.team = Team.objects.create(name='Payload Team')
        self.trainer = User.objects.create_user(username='payload-trainer', password='pw')
        Group.objects.create(name='Trainer').user_set.add(self.trainer)
        profile = Profile.objects.create(user=self.trainer, active_team=self.team)
        profile.teams.add(self.team)
        self.file = File.objects.create(name='Payload map', team=self.team)
        self.client.force_login(self.trainer)

    def oversized_control_pairs(self):
        return [
            {'order': index, 'start': None, 'ziel': None, 'routes': []}
            for index in range(project_views.MAX_EDITOR_CONTROL_PAIRS + 1)
        ]

    def test_full_save_rejects_too_many_control_pairs_before_persisting(self):
        response = self.client.post(
            reverse('save_file'),
            data=json.dumps({
                'id': self.file.id,
                'name': self.file.name,
                'control_pairs': self.oversized_control_pairs(),
            }),
            content_type='application/json',
        )

        self.assertEqual(response.status_code, 413)
        self.assertEqual(response.json()['error'], 'payload_too_large')
        self.assertEqual(self.file.control_pairs.count(), 0)

    def test_snapshot_rejects_too_many_control_pairs_before_persisting(self):
        response = self.client.post(
            reverse('save_snapshot'),
            data=json.dumps({
                'id': self.file.id,
                'control_pairs': self.oversized_control_pairs(),
            }),
            content_type='application/json',
        )

        self.assertEqual(response.status_code, 413)
        self.assertEqual(response.json()['error'], 'payload_too_large')
        self.assertEqual(self.file.snapshots.count(), 0)


class EditorSecurityTests(TestCase):
    def setUp(self):
        self.team = Team.objects.create(name='Team A')
        self.other_team = Team.objects.create(name='Team B')
        self.trainer = User.objects.create_user(username='trainer', password='pw')
        Group.objects.create(name='Trainer').user_set.add(self.trainer)
        profile = Profile.objects.create(user=self.trainer, active_team=self.team)
        profile.teams.add(self.team)
        self.client.force_login(self.trainer)

    def test_snapshots_for_other_team_are_hidden(self):
        other_file = File.objects.create(name='Other', team=self.other_team)
        FileSnapshot.objects.create(file=other_file, created_by=self.trainer, control_pairs=[])

        response = self.client.get(reverse('get_snapshots', args=[other_file.id]))

        self.assertEqual(response.status_code, 404)

    def test_save_file_cannot_claim_inaccessible_map_filename(self):
        File.objects.create(name='Secret', team=self.other_team, map_file='secret.png')

        response = self.client.post(
            reverse('save_file'),
            data=json.dumps({
                'name': 'Copied secret',
                'map_file': 'secret.png',
                'control_pairs': [],
            }),
            content_type='application/json',
        )

        self.assertEqual(response.status_code, 403)

    def test_ocad_upload_returns_pending_and_status_reaches_done(self):
        jobs = []

        def capture_submit(fn, *args):
            jobs.append((fn, args))
            return mock.Mock()

        upload = SimpleUploadedFile(
            'training.ocd',
            b'ocad bytes',
            content_type='application/octet-stream',
        )

        with mock.patch.object(project_views._OCAD_CONVERSION_EXECUTOR, 'submit', side_effect=capture_submit):
            response = self.client.post(reverse('upload_map'), {'file': upload})

        self.assertEqual(response.status_code, 202)
        payload = response.json()
        self.assertTrue(payload['async'])
        self.assertEqual(payload['status'], 'pending')
        self.assertEqual(len(jobs), 1)

        status_response = self.client.get(reverse('ocad_conversion_status', args=[payload['file_id']]))
        self.assertEqual(status_response.status_code, 200)
        self.assertEqual(status_response.json()['progress']['status'], 'pending')

        conversion_result = {
            'scale': 2.5,
            'ocad_map_scale': 7500,
            'scaled': True,
            'control_pairs': [
                {'start': {'x': 1, 'y': 2}, 'ziel': {'x': 3, 'y': 4}, 'routes': []},
            ],
            'courses': 1,
            'controls': 2,
            'mask_symbols': 3,
            'width': 640,
            'height': 480,
        }
        fn, args = jobs[0]
        with (
            mock.patch('django.db.close_old_connections', lambda: None),
            mock.patch('project.ocad_tools.ocad.convert_ocad_map_to_editor_assets', return_value=conversion_result),
        ):
            fn(*args)

        done_response = self.client.get(reverse('ocad_conversion_status', args=[payload['file_id']]))
        self.assertEqual(done_response.status_code, 200)
        progress = done_response.json()['progress']
        self.assertEqual(progress['status'], 'done')
        self.assertEqual(progress['result']['map_scale'], 7500)
        self.assertEqual(progress['result']['control_pairs'], conversion_result['control_pairs'])

    def test_ocad_upload_failure_is_reported_in_status(self):
        jobs = []

        def capture_submit(fn, *args):
            jobs.append((fn, args))
            return mock.Mock()

        upload = SimpleUploadedFile(
            'broken.ocd',
            b'not ocad',
            content_type='application/octet-stream',
        )

        with mock.patch.object(project_views._OCAD_CONVERSION_EXECUTOR, 'submit', side_effect=capture_submit):
            response = self.client.post(reverse('upload_map'), {'file': upload})

        self.assertEqual(response.status_code, 202)
        payload = response.json()

        from project.ocad_tools.ocad import OcadConversionError
        fn, args = jobs[0]
        with (
            mock.patch('django.db.close_old_connections', lambda: None),
            mock.patch(
                'project.ocad_tools.ocad.convert_ocad_map_to_editor_assets',
                side_effect=OcadConversionError('bad file'),
            ),
        ):
            fn(*args)

        failed_response = self.client.get(reverse('ocad_conversion_status', args=[payload['file_id']]))
        self.assertEqual(failed_response.status_code, 200)
        progress = failed_response.json()['progress']
        self.assertEqual(progress['status'], 'failed')
        self.assertIn('bad file', progress['error'])


    def test_shared_pool_file_is_read_only_to_non_owner(self):
        self.team.shared_pool = True
        self.team.save(update_fields=['shared_pool'])
        self.other_team.shared_pool = True
        self.other_team.save(update_fields=['shared_pool'])
        shared_file = File.objects.create(name='Shared', team=self.other_team)

        open_response = self.client.get(reverse('open_file', args=[shared_file.id]))

        self.assertEqual(open_response.status_code, 200)
        project = open_response.json()['project']
        self.assertTrue(project['read_only'])
        self.assertEqual(project['read_only_reason'], 'shared')

        save_response = self.client.post(
            reverse('save_element'),
            data=json.dumps({
                'file_id': shared_file.id,
                'type': 'control_pair',
                'control_pair': {'order': 0},
            }),
            content_type='application/json',
        )

        self.assertEqual(save_response.status_code, 403)
        self.assertEqual(shared_file.control_pairs.count(), 0)


class NavgraphInvalidationTests(TestCase):
    def setUp(self):
        self.team = Team.objects.create(name='Navgraph Team')
        self.trainer = User.objects.create_user(username='navgraph-trainer', password='pw')
        Group.objects.create(name='Trainer').user_set.add(self.trainer)
        profile = Profile.objects.create(user=self.trainer, active_team=self.team)
        profile.teams.add(self.team)
        self.client.force_login(self.trainer)
        self.file = File.objects.create(
            name='Enabled mask',
            team=self.team,
            map_file='enabled-map.png',
            has_mask=True,
            infinite_enabled=True,
        )

    def test_build_status_names_failed_passage_by_sidebar_number(self):
        self.file.level_passages = {
            'version': 1,
            'items': [
                {'id': PASSAGE_ID_1, 'points': [[1, 1], [2, 2]], 'width': 4},
                {'id': PASSAGE_ID_2, 'points': [[3, 3], [4, 4]], 'width': 4},
            ],
        }
        self.file.batch_progress = {
            'type': 'navgraph_build',
            'status': 'failed',
            'error_code': 'passage_connector',
            'passage_id': PASSAGE_ID_2,
            'passage_endpoint': 'end',
            'error': f'passage {PASSAGE_ID_2} end endpoint has no legal base connector',
        }
        self.file.save(update_fields=['level_passages', 'batch_progress'])

        response = self.client.get(
            reverse('navgraph_build_status', args=[self.file.id]))

        self.assertEqual(response.status_code, 200)
        progress = response.json()['progress']
        self.assertEqual(progress['passage_number'], 2)
        self.assertIn('Passage 2', progress['error'])
        self.assertNotIn(PASSAGE_ID_2, progress['error'])

    def test_build_status_names_legacy_raw_uuid_error_by_sidebar_number(self):
        self.file.level_passages = {
            'version': 1,
            'items': [
                {'id': PASSAGE_ID_1, 'points': [[1, 1], [2, 2]], 'width': 4},
                {'id': PASSAGE_ID_2, 'points': [[3, 3], [4, 4]], 'width': 4},
            ],
        }
        self.file.batch_progress = {
            'type': 'navgraph_build',
            'status': 'failed',
            'error': f'passage {PASSAGE_ID_2} start endpoint has no legal base connector',
        }
        self.file.save(update_fields=['level_passages', 'batch_progress'])

        response = self.client.get(
            reverse('navgraph_build_status', args=[self.file.id]))

        self.assertEqual(response.status_code, 200)
        progress = response.json()['progress']
        self.assertEqual(progress['passage_number'], 2)
        self.assertEqual(progress['passage_id'], PASSAGE_ID_2)
        self.assertEqual(progress['passage_endpoint'], 'start')
        self.assertIn('Passage 2', progress['error'])
        self.assertNotIn(PASSAGE_ID_2, progress['error'])

    @staticmethod
    def _write_artifacts(media_root, stem='enabled-map'):
        masks_dir = os.path.join(media_root, 'masks')
        os.makedirs(masks_dir, exist_ok=True)
        paths = [
            os.path.join(masks_dir, f'mask_{stem}.navgraph.bin'),
            os.path.join(masks_dir, f'mask_{stem}.navgraph.npz'),
            os.path.join(masks_dir, f'mask_{stem}.navgraph.debug.png'),
        ]
        for path in paths:
            with open(path, 'wb') as artifact:
                artifact.write(b'stale')
        return paths

    def test_successful_mask_edit_disables_infinite_play(self):
        with tempfile.TemporaryDirectory() as media_root, override_settings(MEDIA_ROOT=media_root):
            artifact_paths = self._write_artifacts(media_root)
            response = self.client.post(reverse('save_mask'), {
                'filename': self.file.map_file,
                'file_id': str(self.file.id),
                'file': SimpleUploadedFile('mask_enabled-map.png', b'updated mask', content_type='image/png'),
            })
            self.assertTrue(all(not os.path.exists(path) for path in artifact_paths))

        self.assertEqual(response.status_code, 200)
        self.assertFalse(response.json()['infinite_enabled'])
        self.file.refresh_from_db()
        self.assertFalse(self.file.infinite_enabled)

    def test_mask_edit_invalidates_an_in_flight_build(self):
        self.file.batch_progress = {
            'type': 'navgraph_build',
            'status': 'building',
            'build_token': 'stale-build',
        }
        self.file.save(update_fields=['batch_progress'])

        with tempfile.TemporaryDirectory() as media_root, override_settings(MEDIA_ROOT=media_root):
            response = self.client.post(reverse('save_mask'), {
                'filename': self.file.map_file,
                'file_id': str(self.file.id),
                'file': SimpleUploadedFile('mask_enabled-map.png', b'updated mask', content_type='image/png'),
            })

        self.assertEqual(response.status_code, 200)
        self.file.refresh_from_db()
        self.assertEqual(self.file.batch_progress['status'], 'invalidated')
        self.assertFalse(self.file.infinite_enabled)

    def test_invalidated_build_cannot_reenable_file_when_it_finishes(self):
        token = 'stale-build'
        self.file.batch_progress = {
            'type': 'navgraph_build',
            'status': 'building',
            'build_token': token,
        }
        self.file.save(update_fields=['batch_progress'])

        def invalidate_during_build(*_args, **_kwargs):
            File.objects.filter(id=self.file.id).update(
                infinite_enabled=False,
                batch_progress={
                    'type': 'navgraph_build',
                    'status': 'invalidated',
                    'build_token': token,
                },
            )
            # Return a realistic artifact so the publish-time currency check runs.
            import numpy as np
            return {
                'stats': {},
                'mask_shape': np.asarray([8, 8], dtype=np.int32),
                'passage_revision': 'p1-deadbeefdeadbeef',
            }

        with tempfile.TemporaryDirectory() as media_root, override_settings(MEDIA_ROOT=media_root):
            mask_dir = os.path.join(media_root, 'masks')
            os.makedirs(mask_dir)
            with open(os.path.join(mask_dir, 'mask_enabled-map.png'), 'wb') as mask_file:
                mask_file.write(b'mask')
            with (
                mock.patch('project.navgraph.build_navgraph', side_effect=invalidate_during_build),
                mock.patch('project.navgraph.save_navgraph'),
                mock.patch('django.db.close_old_connections'),
            ):
                project_views._rebuild_navgraph_for_file(
                    self.file.id,
                    enable_on_success=True,
                    build_token=token,
                )

        self.file.refresh_from_db()
        self.assertFalse(self.file.infinite_enabled)
        self.assertEqual(self.file.batch_progress['status'], 'invalidated')

    def test_region_edit_disables_infinite_play(self):
        with tempfile.TemporaryDirectory() as media_root, override_settings(MEDIA_ROOT=media_root):
            artifact_paths = self._write_artifacts(media_root)
            response = self.client.post(
                reverse('save_region', args=[self.file.id]),
                data=json.dumps({'polygon': [[10, 10], [100, 10], [100, 100], [10, 100]]}),
                content_type='application/json',
            )
            self.assertTrue(all(not os.path.exists(path) for path in artifact_paths))

        self.assertEqual(response.status_code, 200)
        self.file.refresh_from_db()
        self.assertFalse(self.file.infinite_enabled)

    def test_region_save_clips_vertices_to_mask_bounds(self):
        from PIL import Image

        with tempfile.TemporaryDirectory() as media_root, override_settings(MEDIA_ROOT=media_root):
            masks_dir = os.path.join(media_root, 'masks')
            os.makedirs(masks_dir)
            Image.new('L', (8, 6), 255).save(
                os.path.join(masks_dir, 'mask_enabled-map.png'))

            response = self.client.post(
                reverse('save_region', args=[self.file.id]),
                data=json.dumps({
                    'polygon': [[-2, -3], [9, 1], [7, 8], [0, 5]],
                }),
                content_type='application/json',
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.json()['polygon'],
            [[0, 0], [7, 1], [7, 5], [0, 5]],
        )
        self.file.refresh_from_db()
        self.assertEqual(
            self.file.infinite_region,
            [[0, 0], [7, 1], [7, 5], [0, 5]],
        )

    def test_region_delete_clears_polygon_and_disables_infinite_play(self):
        self.file.infinite_region = [[10, 10], [100, 10], [100, 100], [10, 100]]
        self.file.save(update_fields=['infinite_region'])

        with tempfile.TemporaryDirectory() as media_root, override_settings(MEDIA_ROOT=media_root):
            artifact_paths = self._write_artifacts(media_root)
            response = self.client.post(
                reverse('save_region', args=[self.file.id]),
                data=json.dumps({'polygon': []}),
                content_type='application/json',
            )
            self.assertTrue(all(not os.path.exists(path) for path in artifact_paths))

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['polygon'], [])
        self.assertFalse(response.json()['infinite_enabled'])
        self.file.refresh_from_db()
        self.assertIsNone(self.file.infinite_region)
        self.assertFalse(self.file.infinite_enabled)

    def test_passage_edit_disables_infinite_play(self):
        # CR 8.4: passages are baked into the navgraph artifact, so a committed
        # passage edit makes the previous artifact stale and revokes infinite
        # play until the coach reactivates (rebuilds the new revision).
        with tempfile.TemporaryDirectory() as media_root, override_settings(MEDIA_ROOT=media_root):
            artifact_paths = self._write_artifacts(media_root)
            response = self.client.post(
                reverse('save_element'),
                data=json.dumps({
                    'type': 'level_passages',
                    'file_id': self.file.id,
                    'level_passages': level_passages_document(),
                    'route_updates': [],
                }),
                content_type='application/json',
            )
            self.assertTrue(all(not os.path.exists(path) for path in artifact_paths))

        self.assertEqual(response.status_code, 200)
        self.assertFalse(response.json()['infinite_enabled'])
        self.file.refresh_from_db()
        self.assertFalse(self.file.infinite_enabled)

    def test_passage_edit_invalidates_an_in_flight_build(self):
        self.file.batch_progress = {
            'type': 'navgraph_build',
            'status': 'building',
            'build_token': 'stale-build',
        }
        self.file.save(update_fields=['batch_progress'])

        response = self.client.post(
            reverse('save_element'),
            data=json.dumps({
                'type': 'level_passages',
                'file_id': self.file.id,
                'level_passages': level_passages_document(),
                'route_updates': [],
            }),
            content_type='application/json',
        )

        self.assertEqual(response.status_code, 200)
        self.file.refresh_from_db()
        self.assertFalse(self.file.infinite_enabled)
        self.assertEqual(self.file.batch_progress['status'], 'invalidated')

    def test_noop_passage_resave_keeps_infinite_play(self):
        # Re-sending the identical passage document must not needlessly revoke
        # infinite play (the baked artifact is still current).
        document = level_passages_document()
        self.file.level_passages = normalize_level_passages(document)
        self.file.save(update_fields=['level_passages'])

        response = self.client.post(
            reverse('save_element'),
            data=json.dumps({
                'type': 'level_passages',
                'file_id': self.file.id,
                'level_passages': document,
                'route_updates': [],
            }),
            content_type='application/json',
        )

        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()['infinite_enabled'])
        self.file.refresh_from_db()
        self.assertTrue(self.file.infinite_enabled)


class LevelPassagesValidationTests(TestCase):
    def test_null_is_canonical_empty_document(self):
        self.assertEqual(normalize_level_passages(None), empty_level_passages())

    def test_valid_document_is_canonicalized_without_extra_keys(self):
        document = level_passages_document()
        document['ignored'] = True
        document['items'][0]['ignored'] = True

        normalized = normalize_level_passages(document)

        self.assertEqual(normalized, {
            'version': 1,
            'items': [{
                'id': PASSAGE_ID_1,
                'points': [[10.0, 20.5], [30.25, 40.0]],
                'width': 24.0,
            }],
        })

    def test_invalid_documents_are_rejected(self):
        invalid_documents = {
            'unknown version': {'version': 2, 'items': []},
            'non-finite coordinate': level_passages_document(points=[[0, 0], [math.inf, 1]]),
            'width too small': level_passages_document(width=1),
            'width too large': level_passages_document(width=257),
            'missing id': {'version': 1, 'items': [{'points': [[0, 0], [1, 1]], 'width': 2}]},
            'non-uuid id': level_passages_document(passage_id='bridge-one'),
            'identical positions': level_passages_document(points=[[1, 1], [1, 1]]),
            'too many items': {
                'version': 1,
                'items': [
                    {
                        'id': f'00000000-0000-0000-0000-{index:012d}',
                        'points': [[0, 0], [1, 1]],
                        'width': 2,
                    }
                    for index in range(MAX_PASSAGES + 1)
                ],
            },
            'too many points': level_passages_document(
                points=[[index, index] for index in range(MAX_POINTS_PER_PASSAGE + 1)],
            ),
            'oversized document': {
                'version': 1,
                'items': [],
                'padding': 'x' * (MAX_LEVEL_PASSAGES_BYTES + 1),
            },
        }
        duplicate_id = level_passages_document()
        duplicate_id['items'].append({
            'id': PASSAGE_ID_1,
            'points': [[50, 50], [60, 60]],
            'width': 10,
        })
        invalid_documents['duplicate id'] = duplicate_id

        for label, document in invalid_documents.items():
            with self.subTest(label=label):
                with self.assertRaises(LevelPassagesValidationError):
                    normalize_level_passages(document)


class LevelPassagesPersistenceTests(TestCase):
    def setUp(self):
        self.team = Team.objects.create(name='Passage Team')
        self.other_team = Team.objects.create(name='Other Passage Team')
        self.trainer = User.objects.create_user(username='passage-trainer', password='pw')
        Group.objects.create(name='Trainer').user_set.add(self.trainer)
        profile = Profile.objects.create(user=self.trainer, active_team=self.team)
        profile.teams.add(self.team)
        self.client.force_login(self.trainer)
        self.file = File.objects.create(name='Passage map', team=self.team)

    def full_save_payload(self, **overrides):
        payload = {
            'id': self.file.id,
            'name': self.file.name,
            'map_file': '',
            'control_pairs': [],
            'level_passages': level_passages_document(),
        }
        payload.update(overrides)
        return payload

    def test_model_defaults_and_open_normalize_missing_data(self):
        snapshot = FileSnapshot.objects.create(
            file=self.file,
            created_by=self.trainer,
            control_pairs=[],
        )
        self.assertIsNone(self.file.level_passages)
        self.assertIsNone(snapshot.level_passages)

        response = self.client.get(reverse('open_file', args=[self.file.id]))

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['project']['level_passages'], empty_level_passages())

    def test_open_reconciles_stale_has_mask_true_when_png_is_missing(self):
        self.file.map_file = 'map.jpg'
        self.file.has_mask = True
        self.file.save(update_fields=['map_file', 'has_mask'])

        with tempfile.TemporaryDirectory() as media_root, override_settings(MEDIA_ROOT=media_root):
            response = self.client.get(reverse('open_file', args=[self.file.id]))

        self.assertEqual(response.status_code, 200)
        self.assertFalse(response.json()['project']['has_mask'])
        self.file.refresh_from_db()
        self.assertFalse(self.file.has_mask)

    def test_open_reconciles_stale_has_mask_false_when_png_exists(self):
        self.file.map_file = 'map.jpg'
        self.file.has_mask = False
        self.file.save(update_fields=['map_file', 'has_mask'])

        with tempfile.TemporaryDirectory() as media_root, override_settings(MEDIA_ROOT=media_root):
            masks_dir = os.path.join(media_root, 'masks')
            os.makedirs(masks_dir)
            with open(os.path.join(masks_dir, 'mask_map.png'), 'wb') as mask_file:
                mask_file.write(b'png contents are not decoded by open_file')
            response = self.client.get(reverse('open_file', args=[self.file.id]))

        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()['project']['has_mask'])
        self.file.refresh_from_db()
        self.assertTrue(self.file.has_mask)

    def test_full_and_granular_saves_use_same_canonical_representation(self):
        full_document = level_passages_document()
        full_document['items'][0]['width'] = 24
        response = self.client.post(
            reverse('save_file'),
            data=json.dumps(self.full_save_payload(level_passages=full_document)),
            content_type='application/json',
        )
        self.assertEqual(response.status_code, 200)
        self.file.refresh_from_db()
        full_normalized = self.file.level_passages

        granular_document = level_passages_document()
        granular_response = self.client.post(
            reverse('save_element'),
            data=json.dumps({
                'file_id': self.file.id,
                'type': 'level_passages',
                'level_passages': granular_document,
            }),
            content_type='application/json',
        )

        self.assertEqual(granular_response.status_code, 200)
        self.file.refresh_from_db()
        self.assertEqual(self.file.level_passages, full_normalized)
        self.assertEqual(granular_response.json()['level_passages'], full_normalized)
        self.assertEqual(self.file.author, self.trainer.username)
        self.assertEqual(self.file.locked_by, self.trainer)

    def test_passage_save_batches_derived_route_metrics_and_returns_canonical_values(self):
        control_pair = ControlPair.objects.create(file=self.file, order=0)
        first_route = Route.objects.create(
            control_pair=control_pair, order=0, obstacle=1.0, run_time=10.0,
        )
        second_route = Route.objects.create(
            control_pair=control_pair, order=1, obstacle=2.0, run_time=20.0,
        )

        response = self.client.post(
            reverse('save_element'),
            data=json.dumps({
                'file_id': self.file.id,
                'type': 'level_passages',
                'level_passages': level_passages_document(width=30),
                'route_updates': [
                    {
                        'cp_db_id': control_pair.id,
                        'route': {
                            'db_id': first_route.id,
                            'obstacle': 3.5,
                            'run_time': 12.5,
                        },
                    },
                    {
                        'cp_db_id': control_pair.id,
                        'route': {
                            'db_id': second_route.id,
                            'obstacle': 4.5,
                            'run_time': 22.5,
                        },
                    },
                ],
            }),
            content_type='application/json',
        )

        self.assertEqual(response.status_code, 200)
        self.file.refresh_from_db()
        first_route.refresh_from_db()
        second_route.refresh_from_db()
        self.assertEqual(self.file.level_passages, normalize_level_passages(level_passages_document(width=30)))
        self.assertEqual((first_route.obstacle, first_route.run_time), (3.5, 12.5))
        self.assertEqual((second_route.obstacle, second_route.run_time), (4.5, 22.5))
        self.assertEqual(response.json()['route_updates'], [
            {
                'cp_db_id': control_pair.id,
                'route_id': first_route.id,
                'obstacle': 3.5,
                'run_time': 12.5,
            },
            {
                'cp_db_id': control_pair.id,
                'route_id': second_route.id,
                'obstacle': 4.5,
                'run_time': 22.5,
            },
        ])

    def test_passage_batch_rolls_back_when_any_metric_is_invalid(self):
        original_document = normalize_level_passages(level_passages_document(width=24))
        self.file.level_passages = original_document
        self.file.save(update_fields=['level_passages'])
        control_pair = ControlPair.objects.create(file=self.file, order=0)
        first_route = Route.objects.create(
            control_pair=control_pair, order=0, obstacle=1.0, run_time=10.0,
        )
        second_route = Route.objects.create(
            control_pair=control_pair, order=1, obstacle=2.0, run_time=20.0,
        )

        response = self.client.post(
            reverse('save_element'),
            data=json.dumps({
                'file_id': self.file.id,
                'type': 'level_passages',
                'level_passages': level_passages_document(width=30),
                'route_updates': [
                    {
                        'cp_db_id': control_pair.id,
                        'route': {
                            'db_id': first_route.id,
                            'obstacle': 3.5,
                            'run_time': 12.5,
                        },
                    },
                    {
                        'cp_db_id': control_pair.id,
                        'route': {
                            'db_id': second_route.id,
                            'obstacle': 4.5,
                            'run_time': 'not-a-number',
                        },
                    },
                ],
            }),
            content_type='application/json',
        )

        self.assertEqual(response.status_code, 400)
        self.file.refresh_from_db()
        first_route.refresh_from_db()
        second_route.refresh_from_db()
        self.assertEqual(self.file.level_passages, original_document)
        self.assertEqual((first_route.obstacle, first_route.run_time), (1.0, 10.0))
        self.assertEqual((second_route.obstacle, second_route.run_time), (2.0, 20.0))

    def test_passage_batch_rejects_route_from_another_file_without_mutating_target(self):
        target_pair = ControlPair.objects.create(file=self.file, order=0)
        target_route = Route.objects.create(
            control_pair=target_pair, order=0, obstacle=1.0, run_time=10.0,
        )
        other_file = File.objects.create(name='Other passage batch map', team=self.other_team)
        other_pair = ControlPair.objects.create(file=other_file, order=0)
        other_route = Route.objects.create(
            control_pair=other_pair, order=0, obstacle=8.0, run_time=80.0,
        )
        original_document = normalize_level_passages(level_passages_document(width=24))
        self.file.level_passages = original_document
        self.file.save(update_fields=['level_passages'])

        response = self.client.post(
            reverse('save_element'),
            data=json.dumps({
                'file_id': self.file.id,
                'type': 'level_passages',
                'level_passages': level_passages_document(width=30),
                'route_updates': [
                    {
                        'cp_db_id': target_pair.id,
                        'route': {
                            'db_id': target_route.id,
                            'obstacle': 3.5,
                            'run_time': 12.5,
                        },
                    },
                    {
                        'cp_db_id': other_pair.id,
                        'route': {
                            'db_id': other_route.id,
                            'obstacle': 9.5,
                            'run_time': 90.0,
                        },
                    },
                ],
            }),
            content_type='application/json',
        )

        self.assertEqual(response.status_code, 404)
        self.file.refresh_from_db()
        target_route.refresh_from_db()
        other_route.refresh_from_db()
        self.assertEqual(self.file.level_passages, original_document)
        self.assertEqual((target_route.obstacle, target_route.run_time), (1.0, 10.0))
        self.assertEqual((other_route.obstacle, other_route.run_time), (8.0, 80.0))

    def test_full_save_rejects_invalid_data_without_mutating_file(self):
        original = normalize_level_passages(level_passages_document())
        self.file.level_passages = original
        self.file.save(update_fields=['level_passages'])

        response = self.client.post(
            reverse('save_file'),
            data=json.dumps(self.full_save_payload(
                name='Should not be saved',
                level_passages={'version': 99, 'items': []},
            )),
            content_type='application/json',
        )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()['error'], 'invalid_level_passages')
        self.file.refresh_from_db()
        self.assertEqual(self.file.name, 'Passage map')
        self.assertEqual(self.file.level_passages, original)

    def test_unknown_stored_version_is_rejected_without_lock_or_data_loss(self):
        future_document = {
            'version': 2,
            'items': [],
            'future_field': {'must': 'survive'},
        }
        self.file.level_passages = future_document
        self.file.save(update_fields=['level_passages'])

        response = self.client.get(reverse('open_file', args=[self.file.id]))

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()['error'], 'invalid_level_passages')
        self.file.refresh_from_db()
        self.assertEqual(self.file.level_passages, future_document)
        self.assertIsNone(self.file.locked_by)
        self.assertIsNone(self.file.locked_at)

    def test_snapshot_api_and_database_snapshot_round_trip(self):
        document = normalize_level_passages(level_passages_document())
        self.file.level_passages = document
        self.file.save(update_fields=['level_passages'])

        response = self.client.post(
            reverse('save_snapshot'),
            data=json.dumps({
                **self.full_save_payload(level_passages=document),
                'trigger': 'test',
            }),
            content_type='application/json',
        )
        self.assertEqual(response.status_code, 200)
        client_snapshot = self.file.snapshots.get(trigger='test')
        load_response = self.client.get(reverse('load_snapshot', args=[client_snapshot.id]))
        self.assertEqual(load_response.status_code, 200)
        self.assertEqual(load_response.json()['project']['level_passages'], document)

        project_views._create_db_snapshot(self.file, self.trainer, 'database')
        self.assertEqual(self.file.snapshots.get(trigger='database').level_passages, document)

    def test_full_save_without_id_duplicates_passages_but_not_route_schema(self):
        document = normalize_level_passages(level_passages_document())
        response = self.client.post(
            reverse('save_file'),
            data=json.dumps(self.full_save_payload(
                id=None,
                name='Passage map copy',
                level_passages=document,
                control_pairs=[{
                    'order': 0,
                    'start': {'x': 1, 'y': 2},
                    'ziel': {'x': 3, 'y': 4},
                    'routes': [{
                        'order': 0,
                        'rP': [{'x': 1, 'y': 2}, {'x': 3, 'y': 4}],
                        'length': 10,
                    }],
                }],
            )),
            content_type='application/json',
        )

        self.assertEqual(response.status_code, 200)
        copied = File.objects.get(id=response.json()['id'])
        self.assertEqual(copied.level_passages, document)
        route = copied.control_pairs.get().routes.get()
        self.assertFalse(hasattr(route, 'level_passages'))
        self.assertEqual(route.rP, [{'x': 1, 'y': 2}, {'x': 3, 'y': 4}])

    def test_other_team_cannot_read_or_modify_passages(self):
        other_file = File.objects.create(
            name='Private passage map',
            team=self.other_team,
            level_passages=normalize_level_passages(level_passages_document()),
        )

        open_response = self.client.get(reverse('open_file', args=[other_file.id]))
        save_response = self.client.post(
            reverse('save_element'),
            data=json.dumps({
                'file_id': other_file.id,
                'type': 'level_passages',
                'level_passages': empty_level_passages(),
            }),
            content_type='application/json',
        )

        self.assertEqual(open_response.status_code, 403)
        self.assertEqual(save_response.status_code, 403)
        other_file.refresh_from_db()
        self.assertEqual(len(other_file.level_passages['items']), 1)


class EditorLockConflictTests(TestCase):
    """Granular editor writes honour the advisory editor lock (RACE-1/RACE-2)."""

    def setUp(self):
        self.team = Team.objects.create(name='Lock Team')
        trainer_group = Group.objects.create(name='Trainer')
        self.alice = User.objects.create_user(
            username='lock-alice', first_name='Alice', password='pw')
        self.bob = User.objects.create_user(
            username='lock-bob', first_name='Bob', password='pw')
        trainer_group.user_set.add(self.alice, self.bob)
        for user in (self.alice, self.bob):
            profile = Profile.objects.create(user=user, active_team=self.team)
            profile.teams.add(self.team)
        self.file = File.objects.create(name='Locked map', team=self.team)
        self.client.force_login(self.bob)

    def lock_as(self, user, age=timedelta(minutes=1)):
        self.file.locked_by = user
        self.file.locked_at = timezone.now() - age
        self.file.save(update_fields=['locked_by', 'locked_at'])

    def save_control_pair(self):
        return self.client.post(
            reverse('save_element'),
            data=json.dumps({
                'file_id': self.file.id,
                'type': 'control_pair',
                'control_pair': {
                    'order': 0,
                    'start': {'x': 1, 'y': 2},
                    'ziel': {'x': 3, 'y': 4},
                },
            }),
            content_type='application/json',
        )

    def assert_conflict(self, response):
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()['error'], 'conflict')
        self.assertIn('Alice', response.json()['message'])

    def test_granular_control_pair_save_conflicts_with_fresh_foreign_lock(self):
        self.lock_as(self.alice)

        self.assert_conflict(self.save_control_pair())
        self.assertEqual(self.file.control_pairs.count(), 0)
        self.file.refresh_from_db()
        self.assertEqual(self.file.locked_by, self.alice)

    def test_granular_save_succeeds_when_foreign_lock_is_stale(self):
        self.lock_as(self.alice, age=timedelta(minutes=16))

        response = self.save_control_pair()

        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.file.control_pairs.count(), 1)
        self.file.refresh_from_db()
        self.assertEqual(self.file.locked_by, self.bob)

    def test_granular_save_succeeds_when_requester_holds_the_lock(self):
        self.lock_as(self.bob)

        response = self.save_control_pair()

        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.file.control_pairs.count(), 1)

    def test_granular_route_save_conflicts_with_fresh_foreign_lock(self):
        control_pair = ControlPair.objects.create(file=self.file, order=0)
        self.lock_as(self.alice)

        response = self.client.post(
            reverse('save_element'),
            data=json.dumps({
                'file_id': self.file.id,
                'type': 'route',
                'cp_db_id': control_pair.id,
                'route': {'order': 0, 'rP': [{'x': 1, 'y': 2}]},
            }),
            content_type='application/json',
        )

        self.assert_conflict(response)
        self.assertEqual(control_pair.routes.count(), 0)

    def test_save_cp_order_conflicts_with_fresh_foreign_lock(self):
        control_pair = ControlPair.objects.create(file=self.file, order=0)
        self.lock_as(self.alice)

        response = self.client.post(
            reverse('save_cp_order'),
            data=json.dumps({
                'file_id': self.file.id,
                'order': [{'db_id': control_pair.id, 'order': 5}],
            }),
            content_type='application/json',
        )

        self.assert_conflict(response)
        control_pair.refresh_from_db()
        self.assertEqual(control_pair.order, 0)

    def test_save_cp_order_succeeds_when_foreign_lock_is_stale(self):
        control_pair = ControlPair.objects.create(file=self.file, order=0)
        self.lock_as(self.alice, age=timedelta(minutes=16))

        response = self.client.post(
            reverse('save_cp_order'),
            data=json.dumps({
                'file_id': self.file.id,
                'order': [{'db_id': control_pair.id, 'order': 5}],
            }),
            content_type='application/json',
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['status'], 'ok')
        control_pair.refresh_from_db()
        self.assertEqual(control_pair.order, 5)

    def test_delete_element_conflicts_with_fresh_foreign_lock(self):
        control_pair = ControlPair.objects.create(file=self.file, order=0)
        self.lock_as(self.alice)

        response = self.client.post(
            reverse('delete_element'),
            data=json.dumps({
                'file_id': self.file.id,
                'type': 'control_pair',
                'db_id': control_pair.id,
            }),
            content_type='application/json',
        )

        self.assert_conflict(response)
        self.assertTrue(ControlPair.objects.filter(id=control_pair.id).exists())

    def test_delete_element_succeeds_when_requester_holds_the_lock(self):
        control_pair = ControlPair.objects.create(file=self.file, order=0)
        self.lock_as(self.bob)

        response = self.client.post(
            reverse('delete_element'),
            data=json.dumps({
                'file_id': self.file.id,
                'type': 'control_pair',
                'db_id': control_pair.id,
            }),
            content_type='application/json',
        )

        self.assertEqual(response.status_code, 200)
        self.assertFalse(ControlPair.objects.filter(id=control_pair.id).exists())

    def test_passage_save_conflicts_with_fresh_foreign_lock(self):
        self.lock_as(self.alice)

        response = self.client.post(
            reverse('save_element'),
            data=json.dumps({
                'file_id': self.file.id,
                'type': 'level_passages',
                'level_passages': level_passages_document(),
            }),
            content_type='application/json',
        )

        self.assert_conflict(response)
        self.file.refresh_from_db()
        self.assertIsNone(self.file.level_passages)

    def test_full_save_still_conflicts_with_fresh_foreign_lock(self):
        self.lock_as(self.alice)

        response = self.client.post(
            reverse('save_file'),
            data=json.dumps({
                'id': self.file.id,
                'name': 'Renamed',
                'map_file': '',
                'control_pairs': [],
                'level_passages': None,
            }),
            content_type='application/json',
        )

        self.assert_conflict(response)
        self.file.refresh_from_db()
        self.assertEqual(self.file.name, 'Locked map')

    def test_open_file_acquires_lock_and_second_opener_is_read_only(self):
        response = self.client.get(reverse('open_file', args=[self.file.id]))

        self.assertEqual(response.status_code, 200)
        project = response.json()['project']
        self.assertFalse(project['read_only'])
        self.assertIsNone(project['locked_by_name'])
        self.assertIsNone(project['read_only_reason'])
        self.file.refresh_from_db()
        self.assertEqual(self.file.locked_by, self.bob)

        self.client.force_login(self.alice)
        second = self.client.get(reverse('open_file', args=[self.file.id]))

        self.assertEqual(second.status_code, 200)
        project = second.json()['project']
        self.assertTrue(project['read_only'])
        self.assertEqual(project['locked_by_name'], 'Bob')
        self.assertEqual(project['read_only_reason'], 'locked')
        self.file.refresh_from_db()
        self.assertEqual(self.file.locked_by, self.bob)


class LevelPassagesReadEndpointTests(TestCase):
    def setUp(self):
        self.team = Team.objects.create(name='Infinity Passage Team')
        self.other_team = Team.objects.create(name='Other Infinity Passage Team')
        self.trainer = User.objects.create_user(username='infinity-passage-trainer', password='pw')
        Group.objects.create(name='Trainer').user_set.add(self.trainer)
        profile = Profile.objects.create(user=self.trainer, active_team=self.team)
        profile.teams.add(self.team)
        self.file = File.objects.create(name='Infinity passage map', team=self.team)

    def test_endpoint_requires_authentication(self):
        response = self.client.get(reverse('get_level_passages', args=[self.file.id]))

        self.assertEqual(response.status_code, 302)
        self.assertIn('/login/', response['Location'])

    def test_other_team_file_is_hidden(self):
        other_file = File.objects.create(
            name='Private Infinity passage map',
            team=self.other_team,
            level_passages=normalize_level_passages(level_passages_document()),
        )
        self.client.force_login(self.trainer)

        response = self.client.get(reverse('get_level_passages', args=[other_file.id]))

        self.assertEqual(response.status_code, 404)

    def test_missing_data_returns_canonical_empty_document_without_locking(self):
        self.client.force_login(self.trainer)

        response = self.client.get(reverse('get_level_passages', args=[self.file.id]))

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), empty_level_passages())
        self.file.refresh_from_db()
        self.assertIsNone(self.file.locked_by)
        self.assertIsNone(self.file.locked_at)

    def test_valid_data_is_normalized_without_locking(self):
        document = level_passages_document()
        document['ignored'] = True
        document['items'][0]['ignored'] = True
        self.file.level_passages = document
        self.file.save(update_fields=['level_passages'])
        self.client.force_login(self.trainer)

        response = self.client.get(reverse('get_level_passages', args=[self.file.id]))

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), normalize_level_passages(document))
        self.file.refresh_from_db()
        self.assertEqual(self.file.level_passages, document)
        self.assertIsNone(self.file.locked_by)
        self.assertIsNone(self.file.locked_at)

    def test_endpoint_omits_passages_outside_infinity_region(self):
        inside_id = PASSAGE_ID_2
        outside_id = PASSAGE_ID_1
        document = {"version": 1, "items": [
            {"id": inside_id, "points": [[1, 1], [3, 3]], "width": 4},
            {"id": outside_id, "points": [[5, 5], [7, 7]], "width": 4},
        ]}
        with tempfile.TemporaryDirectory() as media_root, override_settings(MEDIA_ROOT=media_root):
            self.file.map_file = 'region-filter.png'
            self.file.infinite_region = [[0, 0], [4, 0], [4, 4], [0, 4]]
            self.file.level_passages = normalize_level_passages(document)
            self.file.save(update_fields=[
                'map_file', 'infinite_region', 'level_passages'])
            _write_mask_png(os.path.join(
                media_root, 'masks', 'mask_region-filter.png'), width=8, height=8)
            self.client.force_login(self.trainer)

            response = self.client.get(
                reverse('get_level_passages', args=[self.file.id]))

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            [item['id'] for item in response.json()['items']], [inside_id])

    def test_infinity_pathing_config_returns_exact_region_and_effective_passages(self):
        inside_id = PASSAGE_ID_2
        outside_id = PASSAGE_ID_1
        document = {"version": 1, "items": [
            {"id": inside_id, "points": [[1, 1], [3, 3]], "width": 4},
            {"id": outside_id, "points": [[5, 5], [7, 7]], "width": 4},
        ]}
        with tempfile.TemporaryDirectory() as media_root, override_settings(MEDIA_ROOT=media_root):
            self.file.map_file = 'pathing-config.png'
            self.file.infinite_region = [[0, 0], [4, 0], [4, 4], [0, 4]]
            self.file.level_passages = normalize_level_passages(document)
            self.file.save(update_fields=[
                'map_file', 'infinite_region', 'level_passages'])
            _write_mask_png(os.path.join(
                media_root, 'masks', 'mask_pathing-config.png'), width=8, height=8)
            self.client.force_login(self.trainer)

            response = self.client.get(
                reverse('get_infinity_pathing_config', args=[self.file.id]))

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload['region'], [[0.0, 0.0], [4.0, 0.0], [4.0, 4.0], [0.0, 4.0]])
        self.assertEqual(payload['width'], 8)
        self.assertEqual(payload['height'], 8)
        self.assertTrue(payload['region_revision'])
        self.assertEqual(
            [item['id'] for item in payload['level_passages']['items']],
            [inside_id],
        )

    def test_infinity_pathing_config_requires_a_saved_region(self):
        with tempfile.TemporaryDirectory() as media_root, override_settings(MEDIA_ROOT=media_root):
            self.file.map_file = 'pathing-config-no-region.png'
            self.file.save(update_fields=['map_file'])
            _write_mask_png(os.path.join(
                media_root, 'masks', 'mask_pathing-config-no-region.png'), width=8, height=8)
            self.client.force_login(self.trainer)

            response = self.client.get(
                reverse('get_infinity_pathing_config', args=[self.file.id]))

        self.assertEqual(response.status_code, 409)


def _write_navgraph_bin(bin_path, revision, height=8, width=8,
                        region_rev=''):
    """Write a minimal current ``.navgraph.bin`` with chosen revisions."""
    import numpy as np
    from project import navgraph

    artifact = {
        'version': navgraph.NAVGRAPH_VERSION,
        'stats': {},
        'nodes': np.zeros((0, 2), '<i4'),
        'edges': np.zeros((0, 2), '<i4'),
        'weights': np.zeros((0,), '<f4'),
        'components': np.zeros((0,), '<i4'),
        'edge_kinds': np.zeros((0,), '<u1'),
        'edge_passage': np.zeros((0,), '<i4'),
        'passage_node_start': np.zeros((0,), '<i4'),
        'passage_node_count': np.zeros((0,), '<i4'),
        'coarse_minval': np.zeros((1, 1), '<u1'),
        'coarse_clear': np.zeros((1, 1), '<u1'),
        'coarse_labels': np.zeros((1, 1), '<i4'),
        'coarse_hitzone': np.zeros((1, 1), '<u1'),
        'mask_shape': np.asarray([height, width], np.int32),
        'min_cost_per_px': 1.0,
        'coarse_scale': 1,
        'hitzone_scale': 1,
        'base_node_count': 0,
        'passage_revision': revision,
        'region_revision': region_rev,
    }
    navgraph._write_bin(bin_path, artifact)


def _write_mask_png(mask_path, width=8, height=8):
    from PIL import Image
    os.makedirs(os.path.dirname(mask_path), exist_ok=True)
    Image.new('L', (width, height), color=255).save(mask_path)


class NavgraphServingGateTests(TestCase):
    """CR 8.4 revision gate: a stale artifact must not be served or listed."""

    def setUp(self):
        self.team = Team.objects.create(name='Gate Team')
        self.trainer = User.objects.create_user(username='gate-trainer', password='pw')
        Group.objects.create(name='Trainer').user_set.add(self.trainer)
        profile = Profile.objects.create(user=self.trainer, active_team=self.team)
        profile.teams.add(self.team)
        self.client.force_login(self.trainer)

    def _make_file(self, media_root, *, passages, infinite_enabled=True,
                   region=None):
        file = File.objects.create(
            name='Gate mask', team=self.team, map_file='gate-map.png',
            has_mask=True, infinite_enabled=infinite_enabled,
            infinite_region=region,
            level_passages=normalize_level_passages(passages) if passages else None,
        )
        masks_dir = os.path.join(media_root, 'masks')
        mask_path = os.path.join(masks_dir, 'mask_gate-map.png')
        bin_path = os.path.join(masks_dir, 'mask_gate-map.navgraph.bin')
        _write_mask_png(mask_path, width=8, height=8)
        return file, mask_path, bin_path

    def test_current_artifact_is_served(self):
        document = level_passages_document()
        with tempfile.TemporaryDirectory() as media_root, override_settings(MEDIA_ROOT=media_root):
            file, _mask, bin_path = self._make_file(media_root, passages=document)
            from project.navgraph import passage_revision
            rev = passage_revision(normalize_level_passages(document), 8, 8)
            _write_navgraph_bin(bin_path, rev, height=8, width=8)

            response = self.client.get(reverse('get_navgraph', args=[file.id]))
            self.assertEqual(response.status_code, 200)
            response.close()  # release the served .bin handle before cleanup

    def test_artifact_currency_reuses_short_lived_result(self):
        document = level_passages_document()
        with tempfile.TemporaryDirectory() as media_root, override_settings(MEDIA_ROOT=media_root):
            file, _mask, bin_path = self._make_file(media_root, passages=document)
            from project.navgraph import passage_revision
            from project.services.media_access import navgraph_artifact_is_current

            rev = passage_revision(normalize_level_passages(document), 8, 8)
            _write_navgraph_bin(bin_path, rev, height=8, width=8)
            self.assertTrue(navgraph_artifact_is_current(file))

            with mock.patch('project.navgraph.mask_dimensions',
                            side_effect=AssertionError('cache miss')):
                self.assertTrue(navgraph_artifact_is_current(file))

    def test_stale_artifact_is_not_served(self):
        document = level_passages_document()
        with tempfile.TemporaryDirectory() as media_root, override_settings(MEDIA_ROOT=media_root):
            file, _mask, bin_path = self._make_file(media_root, passages=document)
            _write_navgraph_bin(bin_path, 'p1-staaaaaale0000', height=8, width=8)

            response = self.client.get(reverse('get_navgraph', args=[file.id]))
            self.assertEqual(response.status_code, 404)

    def test_polygon_artifact_is_served_without_debug_npz(self):
        region = [[1, 1], [7, 1], [7, 7], [1, 7]]
        with tempfile.TemporaryDirectory() as media_root, override_settings(MEDIA_ROOT=media_root):
            file, _mask, bin_path = self._make_file(
                media_root, passages=None, region=region)
            from project.navgraph import (
                _passage_items, passage_revision, region_revision)
            passage_rev = passage_revision(_passage_items(None), 8, 8)
            region_rev = region_revision(region, 8, 8)
            _write_navgraph_bin(
                bin_path, passage_rev, height=8, width=8,
                region_rev=region_rev)

            self.assertFalse(os.path.exists(
                bin_path[:-len('.navgraph.bin')] + '.navgraph.npz'))
            response = self.client.get(reverse('get_navgraph', args=[file.id]))
            self.assertEqual(response.status_code, 200)
            response.close()

    def test_stale_polygon_revision_is_not_served(self):
        region = [[1, 1], [7, 1], [7, 7], [1, 7]]
        with tempfile.TemporaryDirectory() as media_root, override_settings(MEDIA_ROOT=media_root):
            file, _mask, bin_path = self._make_file(
                media_root, passages=None, region=region)
            from project.navgraph import _passage_items, passage_revision
            passage_rev = passage_revision(_passage_items(None), 8, 8)
            _write_navgraph_bin(
                bin_path, passage_rev, height=8, width=8,
                region_rev='r1-stale-region')

            response = self.client.get(reverse('get_navgraph', args=[file.id]))
            self.assertEqual(response.status_code, 404)

    def test_disabled_file_artifact_is_not_served(self):
        with tempfile.TemporaryDirectory() as media_root, override_settings(MEDIA_ROOT=media_root):
            file, _mask, bin_path = self._make_file(
                media_root, passages=None, infinite_enabled=False)
            from project.navgraph import passage_revision, _passage_items
            rev = passage_revision(_passage_items(None), 8, 8)
            _write_navgraph_bin(bin_path, rev, height=8, width=8)

            response = self.client.get(reverse('get_navgraph', args=[file.id]))
            self.assertEqual(response.status_code, 404)

    def test_mask_newer_than_artifact_is_not_served(self):
        with tempfile.TemporaryDirectory() as media_root, override_settings(MEDIA_ROOT=media_root):
            file, mask_path, bin_path = self._make_file(media_root, passages=None)
            from project.navgraph import passage_revision, _passage_items
            rev = passage_revision(_passage_items(None), 8, 8)
            _write_navgraph_bin(bin_path, rev, height=8, width=8)
            bin_mtime = os.path.getmtime(bin_path)
            os.utime(mask_path, (bin_mtime + 10, bin_mtime + 10))

            response = self.client.get(reverse('get_navgraph', args=[file.id]))
            self.assertEqual(response.status_code, 404)

    def test_current_base_only_artifact_serves_for_empty_passages(self):
        with tempfile.TemporaryDirectory() as media_root, override_settings(MEDIA_ROOT=media_root):
            file, _mask, bin_path = self._make_file(media_root, passages=None)
            from project.navgraph import passage_revision, _passage_items
            rev = passage_revision(_passage_items(None), 8, 8)
            _write_navgraph_bin(bin_path, rev, height=8, width=8)

            response = self.client.get(reverse('get_navgraph', args=[file.id]))
            self.assertEqual(response.status_code, 200)
            response.close()  # release the served .bin handle before cleanup

    def test_listing_hides_stale_and_shows_current(self):
        document = level_passages_document()
        with tempfile.TemporaryDirectory() as media_root, override_settings(MEDIA_ROOT=media_root):
            file, _mask, bin_path = self._make_file(media_root, passages=document)

            # Stale artifact -> not listed.
            _write_navgraph_bin(bin_path, 'p1-staaaaaale0000', height=8, width=8)
            response = self.client.get(reverse('infinity_mask_maps'))
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json()['maps'], [])

            # Current artifact -> listed.
            from project.navgraph import passage_revision
            rev = passage_revision(normalize_level_passages(document), 8, 8)
            _write_navgraph_bin(bin_path, rev, height=8, width=8)
            response = self.client.get(reverse('infinity_mask_maps'))
            self.assertEqual([m['id'] for m in response.json()['maps']], [file.id])


class NavgraphRebuildAuthorityTests(TestCase):
    """CR 8.4: the background rebuild is passage-authoritative and stale-safe."""

    def setUp(self):
        self.team = Team.objects.create(name='Rebuild Team')
        self.file = File.objects.create(
            name='Rebuild mask', team=self.team, map_file='rebuild-map.png',
            has_mask=True, infinite_enabled=False,
            infinite_region=[[1, 1], [7, 1], [7, 7], [1, 7]],
            level_passages=normalize_level_passages(
                level_passages_document(points=[[2, 2], [6, 6]])),
        )

    def _artifact_for(self, document):
        import numpy as np
        from project.navgraph import passage_revision, region_revision
        rev = passage_revision(normalize_level_passages(document), 8, 8)
        return {
            'stats': {'n_nodes': 3, 'n_edges': 2, 'n_passages': 1,
                      'hitzone_source': 'polygon',
                      'region_revision': region_revision(
                          self.file.infinite_region, 8, 8)},
            'mask_shape': np.asarray([8, 8], np.int32),
            'passage_revision': rev,
        }

    def _run_build(self, media_root, side_effect):
        token = 'tok-1'
        File.objects.filter(id=self.file.id).update(batch_progress={
            'type': 'navgraph_build', 'status': 'building', 'build_token': token,
        })
        masks_dir = os.path.join(media_root, 'masks')
        _write_mask_png(os.path.join(masks_dir, 'mask_rebuild-map.png'))
        with (
            mock.patch('project.navgraph.build_navgraph', side_effect=side_effect),
            mock.patch('project.navgraph.save_navgraph') as save_mock,
            mock.patch('django.db.close_old_connections'),
        ):
            project_views._rebuild_navgraph_for_file(
                self.file.id, enable_on_success=True, build_token=token)
        return save_mock

    def test_unchanged_document_publishes_and_enables(self):
        document = level_passages_document(points=[[2, 2], [6, 6]])
        with tempfile.TemporaryDirectory() as media_root, override_settings(MEDIA_ROOT=media_root):
            artifact = self._artifact_for(document)
            save_mock = self._run_build(media_root, lambda *a, **k: artifact)

            save_mock.assert_called_once()
            self.file.refresh_from_db()
            self.assertTrue(self.file.infinite_enabled)
            self.assertEqual(self.file.batch_progress['status'], 'done')

    def test_connector_failure_is_persisted_as_structured_passage_error(self):
        from project.navgraph import PassageConnectorError

        with tempfile.TemporaryDirectory() as media_root, override_settings(MEDIA_ROOT=media_root):
            self._run_build(
                media_root,
                PassageConnectorError(PASSAGE_ID_1, 'end'),
            )

        self.file.refresh_from_db()
        progress = self.file.batch_progress
        self.assertEqual(progress['status'], 'failed')
        self.assertEqual(progress['error_code'], 'passage_connector')
        self.assertEqual(progress['passage_id'], PASSAGE_ID_1)
        self.assertEqual(progress['passage_endpoint'], 'end')
        self.assertNotIn(PASSAGE_ID_1, progress['error'])

    def test_legacy_shaped_connector_exception_is_persisted_structurally(self):
        legacy_error = ValueError(
            f'passage {PASSAGE_ID_1} start endpoint has no legal base connector')

        with tempfile.TemporaryDirectory() as media_root, override_settings(MEDIA_ROOT=media_root):
            self._run_build(media_root, legacy_error)

        self.file.refresh_from_db()
        progress = self.file.batch_progress
        self.assertEqual(progress['error_code'], 'passage_connector')
        self.assertEqual(progress['passage_id'], PASSAGE_ID_1)
        self.assertEqual(progress['passage_endpoint'], 'start')
        self.assertNotIn(PASSAGE_ID_1, progress['error'])

    def test_build_callback_persists_pollable_node_progress(self):
        document = level_passages_document(points=[[2, 2], [6, 6]])
        observed = {}

        def build_with_progress(*_args, progress_callback=None, **_kwargs):
            self.assertIsNotNone(progress_callback)
            progress_callback({
                'percent': 68,
                'phase': 'connect_nodes',
                'current': 34,
                'total': 50,
            })
            self.file.refresh_from_db()
            observed.update(self.file.batch_progress)
            return self._artifact_for(document)

        with tempfile.TemporaryDirectory() as media_root, override_settings(MEDIA_ROOT=media_root):
            self._run_build(media_root, build_with_progress)

        self.assertEqual(observed['status'], 'building')
        self.assertEqual(observed['percent'], 68)
        self.assertEqual(observed['phase'], 'connect_nodes')
        self.assertEqual(observed['current'], 34)
        self.assertEqual(observed['total'], 50)

    def test_passage_edit_during_build_is_reported_stale(self):
        document = level_passages_document(points=[[2, 2], [6, 6]])
        with tempfile.TemporaryDirectory() as media_root, override_settings(MEDIA_ROOT=media_root):
            artifact = self._artifact_for(document)

            def build_then_edit(*_a, **_k):
                # The coach commits a different passage document mid-build.
                File.objects.filter(id=self.file.id).update(
                    level_passages=normalize_level_passages(
                        level_passages_document(
                            width=48, points=[[2, 2], [6, 6]])))
                return artifact

            save_mock = self._run_build(media_root, build_then_edit)

            save_mock.assert_not_called()
            self.file.refresh_from_db()
            self.assertFalse(self.file.infinite_enabled)
            self.assertEqual(self.file.batch_progress['status'], 'stale')

    def test_superseded_build_cannot_overwrite_newer_build_progress(self):
        document = level_passages_document(points=[[2, 2], [6, 6]])
        with tempfile.TemporaryDirectory() as media_root, override_settings(MEDIA_ROOT=media_root):
            artifact = self._artifact_for(document)

            def finish_after_replacement_started(*_args, **_kwargs):
                File.objects.filter(id=self.file.id).update(batch_progress={
                    'type': 'navgraph_build',
                    'status': 'building',
                    'build_token': 'tok-2',
                    'percent': 23,
                    'phase': 'analysing',
                })
                return artifact

            save_mock = self._run_build(media_root, finish_after_replacement_started)

            save_mock.assert_not_called()
            self.file.refresh_from_db()
            self.assertEqual(self.file.batch_progress['status'], 'building')
            self.assertEqual(self.file.batch_progress['build_token'], 'tok-2')
            self.assertEqual(self.file.batch_progress['percent'], 23)

    def test_progress_checkpoint_cancels_superseded_worker_silently(self):
        from project.navgraph import NavgraphBuildCancelled

        def supersede_then_report(*_args, progress_callback=None, **_kwargs):
            File.objects.filter(id=self.file.id).update(batch_progress={
                'type': 'navgraph_build',
                'status': 'building',
                'build_token': 'tok-2',
                'percent': 7,
                'phase': 'preparing',
            })
            if progress_callback({'percent': 10, 'phase': 'analysing'}) is False:
                raise NavgraphBuildCancelled()
            self.fail('The superseded worker was not cancelled')

        with tempfile.TemporaryDirectory() as media_root, override_settings(MEDIA_ROOT=media_root):
            save_mock = self._run_build(media_root, supersede_then_report)

            save_mock.assert_not_called()
            self.file.refresh_from_db()
            self.assertEqual(self.file.batch_progress['build_token'], 'tok-2')
            self.assertEqual(self.file.batch_progress['status'], 'building')


class BuildNavgraphCommandAmbiguityTests(TestCase):
    """CR 8.4 item 5: shared-map ambiguity is skipped with a diagnostic."""

    def setUp(self):
        self.team = Team.objects.create(name='Cmd Team')

    def test_conflicting_shared_map_rows_are_skipped(self):
        from django.core.management import call_command
        from io import StringIO

        with tempfile.TemporaryDirectory() as media_root, override_settings(MEDIA_ROOT=media_root):
            # Two File rows share one map_file but disagree on the region.
            File.objects.create(
                name='A', team=self.team, map_file='shared.png', has_mask=True,
                infinite_region=[[1, 1], [7, 1], [7, 7], [1, 7]])
            File.objects.create(
                name='B', team=self.team, map_file='shared.png', has_mask=True,
                infinite_region=[[2, 2], [6, 2], [6, 6], [2, 6]])
            mask_path = os.path.join(media_root, 'masks', 'mask_shared.png')
            _write_mask_png(mask_path)

            out = StringIO()
            call_command('build_navgraph', file=mask_path, stdout=out)
            output = out.getvalue()

        self.assertIn('refusing to guess', output)
        self.assertIn('1 ambiguous', output)
        # Ambiguity must not produce an artifact.
        self.assertFalse(os.path.isfile(
            os.path.join(media_root, 'masks', 'mask_shared.navgraph.bin')))

    def test_default_build_is_binary_only_and_binary_is_fresh(self):
        from django.core.management import call_command
        from io import StringIO

        with tempfile.TemporaryDirectory() as media_root, override_settings(MEDIA_ROOT=media_root):
            mask_path = os.path.join(media_root, 'masks', 'mask_orphan.png')
            _write_mask_png(mask_path, width=32, height=32)

            first = StringIO()
            call_command('build_navgraph', file=mask_path, stdout=first)
            bin_path = os.path.splitext(mask_path)[0] + '.navgraph.bin'
            npz_path = os.path.splitext(mask_path)[0] + '.navgraph.npz'
            self.assertTrue(os.path.isfile(bin_path))
            self.assertFalse(os.path.isfile(npz_path))

            second = StringIO()
            call_command('build_navgraph', file=mask_path, stdout=second)
            self.assertIn('SKIP', second.getvalue())
            self.assertIn('up to date', second.getvalue())
