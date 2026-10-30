# yaac: zsh startup in a containerless workspace (docs/containerless-driver.md
# "Shell startup"). ZDOTDIR points here, so zsh reads these files in place of
# the user's. Each one sources the user's own file at top level, with ZDOTDIR
# set as the user's file expects, then re-applies yaac's environment
# ($YAAC_SHELL_ENV), which that file may have changed. That also points
# ZDOTDIR back here, for the next file and for every nested zsh.
_yaac_zdotdir=$ZDOTDIR
_yaac_user_zdotdir=$YAAC_USER_ZDOTDIR
ZDOTDIR=$_yaac_user_zdotdir
[[ -r $ZDOTDIR/.zshenv ]] && . $ZDOTDIR/.zshenv
_yaac_user_zdotdir=$ZDOTDIR
. $YAAC_SHELL_ENV
typeset -U PATH path
