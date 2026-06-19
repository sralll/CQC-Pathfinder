from django import forms
from django.contrib.auth.forms import AuthenticationForm, PasswordChangeForm
from django.utils.translation import gettext_lazy as _

class StyledLoginForm(AuthenticationForm):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.fields['username'].widget.attrs.update({
            'class': 'form-control',
            'placeholder': _('Username')
        })
        self.fields['password'].widget.attrs.update({
            'class': 'form-control',
            'placeholder': _('Password')
        })

class StyledPasswordChangeForm(PasswordChangeForm):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.fields['old_password'].label = _('Current password')
        self.fields['new_password1'].label = _('New password')
        self.fields['new_password2'].label = _('Confirm new password')
        for field in self.fields.values():
            field.help_text = ''
            field.widget.attrs.update({'class': 'ui-input'})
