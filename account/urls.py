from django.urls import path
from . import views

urlpatterns = [
    path('switch_team/<int:team_id>/', views.switch_team, name='switch_team'),
]