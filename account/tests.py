from django.contrib.auth.models import Group, User
from django.test import TestCase
from django.urls import reverse

from .models import ForumComment, ForumThread, Profile, Team


class ForumQueryCountTests(TestCase):
    def setUp(self):
        self.team = Team.objects.create(name='Team A')
        self.user = User.objects.create_user(username='athlete', password='pw')
        profile = Profile.objects.create(user=self.user, active_team=self.team)
        profile.teams.add(self.team)
        self.author = User.objects.create_user(username='author')
        self.thread = ForumThread.objects.create(
            author=self.author,
            title='Route choice discussion',
            body='Which route did you take?',
        )
        self.thread.upvotes.add(self.user)
        for idx in range(3):
            comment = ForumComment.objects.create(
                thread=self.thread,
                author=self.author,
                body=f'Comment {idx}',
            )
            comment.upvotes.add(self.user)
        self.client.force_login(self.user)

    def test_forum_thread_uses_annotated_thread_upvote_count(self):
        # Locks in the Phase 2.2 fix: the thread upvote count comes from the
        # annotated thread query instead of a separate thread.upvotes.count().
        with self.assertNumQueries(9):
            response = self.client.get(reverse('forum_thread', args=[self.thread.pk]))

        self.assertEqual(response.status_code, 200)
        self.assertContains(response, 'Route choice discussion')


class StaffUserAdminTests(TestCase):
    def setUp(self):
        self.team = Team.objects.create(name='Staff team')
        self.athlete_role = Group.objects.create(name='Athlete')
        self.staff = User.objects.create_user(
            username='staff',
            password='staff-password',
            is_staff=True,
        )
        profile = Profile.objects.create(
            user=self.staff,
            active_team=self.team,
        )
        profile.teams.add(self.team)
        self.client.force_login(self.staff)

    def test_staff_can_create_user_assigned_to_active_team(self):
        response = self.client.post(
            reverse('admin:auth_user_add'),
            {
                'username': 'new-athlete',
                'password1': 'Strong-Enough-Password-2026',
                'password2': 'Strong-Enough-Password-2026',
                'first_name': 'New',
                'last_name': 'Athlete',
                'email': 'athlete@example.com',
                'groups': [self.athlete_role.pk],
            },
        )

        created_user = User.objects.get(username='new-athlete')
        self.assertRedirects(
            response,
            reverse('admin:auth_user_change', args=[created_user.pk]),
        )
        self.assertEqual(created_user.profile.active_team, self.team)
        self.assertEqual(list(created_user.profile.teams.all()), [self.team])
        self.assertEqual(list(created_user.groups.all()), [self.athlete_role])
