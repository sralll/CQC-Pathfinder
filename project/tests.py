import json

from django.contrib.auth.models import Group, User
from django.test import TestCase
from django.urls import reverse

from account.models import Profile, Team
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
