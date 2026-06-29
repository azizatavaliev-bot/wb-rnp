#!/bin/bash
# ================================================================
# 🚀 Создать новый РНП-кабинет на Railway
# Использование: ./create-rnp.sh "Название магазина"
# ================================================================

NAME="${1:-МойМагазин}"
SLUG=$(echo "$NAME" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g' | sed 's/--*/-/g' | sed 's/^-//' | sed 's/-$//')
RAILWAY_TOKEN="${RAILWAY_TOKEN:-$(security find-generic-password -a claude-workspace -s railway-token -w 2>/dev/null)}"
GH_TOKEN="${GH_TOKEN:-$(security find-generic-password -a claude-workspace -s claude.github.token -w 2>/dev/null)}"

if [ -z "$RAILWAY_TOKEN" ]; then
  echo "❌ Нет RAILWAY_TOKEN"
  exit 1
fi

echo "🚀 Создаю РНП-кабинет: $NAME (slug: $SLUG)"

# 1. Создать Railway проект
PROJ=$(curl -s -X POST "https://backboard.railway.app/graphql/v2" \
  -H "Authorization: Bearer $RAILWAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"query\":\"mutation { projectCreate(input:{name:\\\"RNP-$NAME\\\"}) { id name } }\"}")
PROJ_ID=$(echo "$PROJ" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['data']['projectCreate']['id'])")
echo "✅ Проект создан: $PROJ_ID"

# 2. Получить environment
sleep 1
ENV=$(curl -s -X POST "https://backboard.railway.app/graphql/v2" \
  -H "Authorization: Bearer $RAILWAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"query\":\"{ project(id:\\\"$PROJ_ID\\\") { environments { edges { node { id name } } } } }\"}")
ENV_ID=$(echo "$ENV" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['data']['project']['environments']['edges'][0]['node']['id'])")
echo "✅ Environment: $ENV_ID"

# 3. Создать сервис из репо
SVC=$(curl -s -X POST "https://backboard.railway.app/graphql/v2" \
  -H "Authorization: Bearer $RAILWAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"query\":\"mutation { serviceCreate(input:{projectId:\\\"$PROJ_ID\\\",name:\\\"rnp\\\",source:{repo:\\\"azizatavaliev-bot/wb-rnp\\\"}}) { id } }\"}")
SVC_ID=$(echo "$SVC" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['data']['serviceCreate']['id'])")
echo "✅ Сервис: $SVC_ID"

# 4. Переменные
curl -s -X POST "https://backboard.railway.app/graphql/v2" \
  -H "Authorization: Bearer $RAILWAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"query\":\"mutation { variableUpsert(input:{projectId:\\\"$PROJ_ID\\\",environmentId:\\\"$ENV_ID\\\",serviceId:\\\"$SVC_ID\\\",name:\\\"PORT\\\",value:\\\"3000\\\"}) }\"}" > /dev/null

# 5. Deploy
curl -s -X POST "https://backboard.railway.app/graphql/v2" \
  -H "Authorization: Bearer $RAILWAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"query\":\"mutation { serviceInstanceDeploy(serviceId:\\\"$SVC_ID\\\",environmentId:\\\"$ENV_ID\\\") }\"}" > /dev/null

# 6. Домен
sleep 2
DOMAIN=$(curl -s -X POST "https://backboard.railway.app/graphql/v2" \
  -H "Authorization: Bearer $RAILWAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"query\":\"mutation { serviceDomainCreate(input:{serviceId:\\\"$SVC_ID\\\",environmentId:\\\"$ENV_ID\\\"}) { domain } }\"}")
URL=$(echo "$DOMAIN" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['data']['serviceDomainCreate']['domain'])" 2>/dev/null)

echo ""
echo "═══════════════════════════════════════════"
echo "🎉 РНП-кабинет создаётся!"
echo "📊 Магазин: $NAME"
echo "🌐 URL: https://$URL"
echo "⏳ Деплой займёт ~2 минуты"
echo "═══════════════════════════════════════════"
echo ""
echo "Открыть когда готово: open https://$URL"
