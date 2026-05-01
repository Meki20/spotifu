from . import auth, search, play, stream, library, settings, artist, album, prefetch, covers, soulseek, admin

auth_router = auth.router
search_router = search.router
play_router = play.router
stream_router = stream.router
library_router = library.router
settings_router = settings.router
artist_router = artist.router
album_router = album.router
prefetch_router = prefetch.router
covers_router = covers.router
soulseek_router = soulseek.router
admin_router = admin.router