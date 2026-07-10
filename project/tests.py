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
from project.models import File, FileSnapshot
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
