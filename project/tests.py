import json
import math
import os
import tempfile
from unittest import mock

from django.contrib.auth.models import Group, User
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import TestCase, override_settings
from django.urls import reverse

from account.models import Profile, Team
from project import views as project_views
from project.models import ControlPair, File, FileSnapshot, Route
from project.passage_validation import (
    MAX_LEVEL_PASSAGES_BYTES,
    MAX_PASSAGES,
    MAX_POINTS_PER_PASSAGE,
    LevelPassagesValidationError,
    empty_level_passages,
    normalize_level_passages,
)


PASSAGE_ID_1 = '8cb8a384-c073-4a4d-9dce-b67e2c6de101'
PASSAGE_ID_2 = '7b03b060-a710-4874-932f-cf4a2b425313'


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


def _write_navgraph_bin(bin_path, revision, height=8, width=8):
    """Write a minimal but structurally valid v3 ``.navgraph.bin`` carrying a
    chosen baked ``passage_revision`` (test helper for the serving/listing
    revision gate)."""
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

    def _make_file(self, media_root, *, passages, infinite_enabled=True):
        file = File.objects.create(
            name='Gate mask', team=self.team, map_file='gate-map.png',
            has_mask=True, infinite_enabled=infinite_enabled,
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

    def test_stale_artifact_is_not_served(self):
        document = level_passages_document()
        with tempfile.TemporaryDirectory() as media_root, override_settings(MEDIA_ROOT=media_root):
            file, _mask, bin_path = self._make_file(media_root, passages=document)
            _write_navgraph_bin(bin_path, 'p1-staaaaaale0000', height=8, width=8)

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

    def test_base_only_v3_serves_for_empty_passages(self):
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
