from django.contrib.auth.models import User
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
