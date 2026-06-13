from django import forms
from django.contrib.auth.forms import AuthenticationForm, PasswordChangeForm

class StyledLoginForm(AuthenticationForm):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.fields['username'].widget.attrs.update({
            'class': 'form-control',
            'placeholder': 'Benutzername'
        })
        self.fields['password'].widget.attrs.update({
            'class': 'form-control',
            'placeholder': 'Passwort'
        })

class StyledPasswordChangeForm(PasswordChangeForm):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.fields['old_password'].label = 'Aktuelles Passwort'
        self.fields['new_password1'].label = 'Neues Passwort'
        self.fields['new_password2'].label = 'Neues Passwort bestätigen'
        for field in self.fields.values():
            field.help_text = ''
            field.widget.attrs.update({'class': 'ui-input'})
