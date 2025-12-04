from django import forms
from .models import Feedback

class FeedbackForm(forms.ModelForm):
    class Meta:
        model = Feedback
        fields = ['comment']
        widgets = {
            'comment': forms.Textarea(attrs={
                'rows': 5,
                'cols': 60,
                'maxlength': 1000,
                'placeholder': 'Kommentare sind anonym',
                'style': 'width: 100%; max-width: 750px;',
                }),
        }
