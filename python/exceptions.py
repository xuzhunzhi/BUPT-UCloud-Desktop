"""自定义异常，便于调用者区分错误类型。"""


class BUPTHomeworkError(Exception):
    """所有项目异常的基类。"""
    pass


class ConfigError(BUPTHomeworkError):
    """配置相关错误（缺少文件、缺少必填项等）。"""
    pass


class LoginError(BUPTHomeworkError):
    """登录失败（凭据错误、验证码、网络问题等）。"""
    pass


class FetchError(BUPTHomeworkError):
    """抓取失败（页面无法访问、解析错误等）。"""
    pass


class NetworkError(BUPTHomeworkError):
    """网络请求失败（超时、无法连接等）。"""
    pass
