import json
from unittest import mock

from django.contrib.auth.models import Group, User
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import TestCase
from django.urls import reverse

from account.models import Profile, Team
from project import views as project_views
from project.models import File, FileSnapshot


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
