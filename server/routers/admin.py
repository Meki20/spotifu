from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlmodel import Session, select

from database import get_session
from deps import require_admin, CurrentUser
from models import User, UserPermission

router = APIRouter(prefix="/admin", tags=["admin"])


class UserPermissionUpdate(BaseModel):
    can_play: bool | None = None
    can_download: bool | None = None
    can_use_soulseek: bool | None = None
    can_access_apis: bool | None = None
    can_view_recently_downloaded: bool | None = None


class UserWithPermissions(BaseModel):
    id: int
    username: str
    is_admin: bool
    permissions: UserPermissionUpdate | None = None


class UserListResponse(BaseModel):
    users: list[UserWithPermissions]
    total: int


@router.get("/users", response_model=UserListResponse)
def list_users(
    admin: CurrentUser = Depends(require_admin),
    session: Session = Depends(get_session),
):
    users = session.exec(select(User).order_by(User.id)).all()
    total = len(users)

    result = []
    for user in users:
        perms = session.get(UserPermission, user.id)
        result.append(UserWithPermissions(
            id=user.id,
            username=user.username,
            is_admin=user.is_admin,
            permissions=UserPermissionUpdate(
                can_play=perms.can_play if perms else False,
                can_download=perms.can_download if perms else False,
                can_use_soulseek=perms.can_use_soulseek if perms else False,
                can_access_apis=perms.can_access_apis if perms else False,
                can_view_recently_downloaded=perms.can_view_recently_downloaded if perms else False,
            ) if perms else None,
        ))

    return UserListResponse(users=result, total=total)


@router.get("/users/{user_id}", response_model=UserWithPermissions)
def get_user(
    user_id: int,
    admin: CurrentUser = Depends(require_admin),
    session: Session = Depends(get_session),
):
    user = session.get(User, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    perms = session.get(UserPermission, user.id)
    return UserWithPermissions(
        id=user.id,
        username=user.username,
        is_admin=user.is_admin,
        permissions=UserPermissionUpdate(
            can_play=perms.can_play if perms else False,
            can_download=perms.can_download if perms else False,
            can_use_soulseek=perms.can_use_soulseek if perms else False,
            can_access_apis=perms.can_access_apis if perms else False,
            can_view_recently_downloaded=perms.can_view_recently_downloaded if perms else False,
        ) if perms else None,
    )


@router.patch("/users/{user_id}/permissions")
def update_user_permissions(
    user_id: int,
    body: UserPermissionUpdate,
    admin: CurrentUser = Depends(require_admin),
    session: Session = Depends(get_session),
):
    user = session.get(User, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    if user.is_admin and user_id != admin.user.id:
        raise HTTPException(status_code=400, detail="Cannot modify permissions of other admins")

    perms = session.get(UserPermission, user_id)
    if not perms:
        perms = UserPermission(user_id=user_id)
        session.add(perms)

    update_data = body.model_dump(exclude_unset=True)
    for field, value in update_data.items():
        setattr(perms, field, value)

    session.add(perms)
    session.commit()

    return {"status": "ok", "user_id": user_id}


@router.post("/users/{user_id}/revoke")
def revoke_all_permissions(
    user_id: int,
    admin: CurrentUser = Depends(require_admin),
    session: Session = Depends(get_session),
):
    user = session.get(User, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    if user.is_admin:
        raise HTTPException(status_code=400, detail="Cannot revoke permissions of admin")

    perms = session.get(UserPermission, user_id)
    if perms:
        perms.can_play = False
        perms.can_download = False
        perms.can_use_soulseek = False
        perms.can_access_apis = False
        perms.can_view_recently_downloaded = False
        session.add(perms)
        session.commit()

    return {"status": "ok", "user_id": user_id}


@router.post("/users/{user_id}/grant-all")
def grant_all_permissions(
    user_id: int,
    admin: CurrentUser = Depends(require_admin),
    session: Session = Depends(get_session),
):
    user = session.get(User, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    perms = session.get(UserPermission, user_id)
    if not perms:
        perms = UserPermission(user_id=user_id)
        session.add(perms)

    perms.can_play = True
    perms.can_download = True
    perms.can_use_soulseek = True
    perms.can_access_apis = True
    perms.can_view_recently_downloaded = True
    session.add(perms)
    session.commit()

    return {"status": "ok", "user_id": user_id}


@router.delete("/users/{user_id}")
def delete_user(
    user_id: int,
    admin: CurrentUser = Depends(require_admin),
    session: Session = Depends(get_session),
):
    user = session.get(User, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    if user.is_admin:
        raise HTTPException(status_code=400, detail="Cannot delete admin users")

    session.delete(user)
    session.commit()

    return {"status": "ok", "user_id": user_id}