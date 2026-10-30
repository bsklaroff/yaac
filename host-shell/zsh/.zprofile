# yaac: see .zshenv.
ZDOTDIR=$_yaac_user_zdotdir
[[ -r $ZDOTDIR/.zprofile ]] && . $ZDOTDIR/.zprofile
_yaac_user_zdotdir=$ZDOTDIR
. $YAAC_SHELL_ENV
