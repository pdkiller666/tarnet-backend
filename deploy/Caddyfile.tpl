# TarNet — reverse-proxy с автоматическим TLS (Let's Encrypt).
#
# Шаблон для scripts/bootstrap.sh: {{DOMAIN}} подставляется при установке.
# В репозитории его не было — конфиг жил только на одном сервере, и при
# переезде reverse-proxy приходилось восстанавливать руками. Это и есть
# дыра переносимости, которую закрывает этот файл.
#
# Что важно сохранить при правках:
#   - header_up X-Real-IP: без него лимиты и логи видят адрес Caddy, не клиента,
#     и rate-limit начинает считать всех одним человеком.
#   - 3001 наружу не проксируется напрямую, только через этот блок: иначе API
#     окажется без TLS.

{{DOMAIN}} {
	encode gzip
	reverse_proxy 127.0.0.1:3001 {
		header_up X-Real-IP {remote_host}
	}
	log {
		output file /var/log/caddy/tarnet-access.log {
			roll_size 10mb
			roll_keep 3
		}
		format json
	}
}
