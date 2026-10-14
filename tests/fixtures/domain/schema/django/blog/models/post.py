from django.db.models import CASCADE, CharField, ForeignKey, Model


class Post(Model):
    title = CharField(max_length=200)
    author = ForeignKey('accounts.Author', on_delete=CASCADE)


class Helper:
    title = CharField(max_length=10)
