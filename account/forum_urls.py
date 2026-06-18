from django.urls import path

from . import views

urlpatterns = [
    path('', views.forum_index, name='forum'),
    path('thread/<int:pk>/', views.forum_thread, name='forum_thread'),
    path('thread/<int:pk>/vote/', views.forum_thread_vote, name='forum_thread_vote'),
    path('thread/<int:pk>/edit/', views.forum_thread_edit, name='forum_thread_edit'),
    path('comment/<int:pk>/vote/', views.forum_comment_vote, name='forum_comment_vote'),
    path('comment/<int:pk>/edit/', views.forum_comment_edit, name='forum_comment_edit'),
]
