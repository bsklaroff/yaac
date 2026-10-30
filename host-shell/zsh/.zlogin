# yaac: see .zshenv.
ZDOTDIR=$_yaac_user_zdotdir
[[ -r $ZDOTDIR/.zlogin ]] && . $ZDOTDIR/.zlogin
_yaac_user_zdotdir=$ZDOTDIR
. $YAAC_SHELL_ENV
